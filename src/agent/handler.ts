// handler.ts — answers an agent's requests from the app's live state. The app hands over an adapter
// (its state, its samples with their gating, its dispatch, its view, its plot) and the handler
// does the reading and the arithmetic: counts, distributions, medians, a command previewed on a
// copy of the state, a command applied through the reducer. Nothing here keeps state of its own
// beyond the revision counter, so what the agent sees is what the user sees.

import { coreReducer, recomputeGating, type Action, type CoreState, type GatingDerived } from "../store";
import { populationTreeOrder } from "../engine/populations";
import type { Gate, GateProvenance, GateTransforms, Vertex } from "../engine/models";
import type { Sample } from "../engine/sample";
import { buildHostedMemberships, gatingStateForTree, workspaceHierarchyTrees, type HierarchyTree } from "../host/hostedMemberships";
import { AgentCommandError, commandToAction, type AgentCommand } from "./commands";
import {
  QUANTILES, STATS_SAMPLE,
  type AgentApplied, type AgentApplyParams, type AgentAxisDistribution, type AgentChannel, type AgentDescribe,
  type AgentDistribution, type AgentDistributionParams, type AgentDistributionSeries, type AgentError, type AgentGate,
  type AgentHostInfo, type AgentMemberships, type AgentMembershipsParams, type AgentPopulation, type AgentPopulationStats,
  type AgentPreview, type AgentPreviewParams, type AgentRender, type AgentRenderParams, type AgentRequest, type AgentResponse,
  type AgentSampleInfo, type AgentSeriesSelection, type AgentStats, type AgentStatsParams, type AgentView, type AgentViewParams,
  type AgentWorkspace,
} from "./protocol";

/** One loaded file or SCE sample, as the app holds it. */
export interface AgentSampleView {
  id: string;
  name: string;
  sample: Sample;
  viewed: boolean;
  checked: boolean;
  /** The Metadata tab's columns for the sample. */
  metadata: Record<string, string>;
  /** The hierarchy the sample is gated under, as the app assigns it. */
  hierarchyId: string;
  /** The sample gated under the tree it follows, with the app's own caching. */
  gating: () => GatingDerived;
}

/** What the app lends the handler. Every call reads the app as it is at that moment. */
export interface AgentAdapter {
  info(): AgentHostInfo;
  state(): CoreState;
  samples(): AgentSampleView[];
  dispatch(action: Action): void;
  /** Resolves once state() reflects the last dispatch. */
  settled(): Promise<void>;
  view(): AgentView;
  setView(view: AgentViewParams): Promise<void>;
  render(params: AgentRenderParams): Promise<{ png: string; width: number; height: number }>;
  workspaceJson(): string | null;
  /** Fit the Gating plot's axes to the data and the gates on them, as the Fit button does. */
  fit(): void;
  /** Hold a channel at a range in display units, as the Scales tab's Min/Max does. */
  setAxisRange(channel: string, range: [number, number]): void;
  /** Drop the plot's own pan or zoom, so the axes show the held or fitted range again. */
  clearPan(): void;
  /** Reload the page: the same URL, so a tab opened with ?agent= reconnects. */
  reload(): void;
}

export interface AgentHandler {
  handle(request: AgentRequest): Promise<AgentResponse>;
  /** A number that moves whenever the gating state has moved since the handler last looked. */
  revision(): number;
  /** The name the agent introduced itself with, put on every gate it makes. */
  setWriter(name: string): void;
}

const fail = (code: AgentError["code"], message: string, revision?: number): AgentError => ({ code, message, ...(revision === undefined ? {} : { revision }) });

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringList(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v)) throw new AgentCommandError(`${label} must be a list of ids.`);
  return value as string[];
}

function channelKind(sample: Sample, idx: number): AgentChannel["kind"] {
  if (sample.isScatterAxis(idx)) return "scatter";
  if (sample.instrument === "cytof") return sample.isFluorChannel(idx) ? "cytof" : "other";
  return sample.isFluorChannel(idx) ? "fluorescence" : "other";
}

function gateView(gate: Gate): AgentGate {
  const base = {
    id: gate.gate_id, name: gate.name, type: gate.gate_type, x: gate.x_channel, y: gate.y_channel,
    space: gate.space ?? null, color: gate.color,
    ...(gate.transforms ? { transforms: gate.transforms } : {}),
    ...(gate.provenance ? { provenance: gate.provenance } : {}),
  };
  if (gate.gate_type === "quadrant") return { ...base, center: [...gate.center] as Vertex };
  if (gate.gate_type === "ellipse") {
    const [[a, b], [c, d]] = gate.covariance;
    return { ...base, ellipse: { mean: [...gate.mean] as Vertex, covariance: [[a, b], [c, d]], distanceSquare: gate.distance_square } };
  }
  return { ...base, vertices: gate.vertices.map((v) => [...v] as Vertex), ...(gate.bounds ? { bounds: gate.bounds } : {}) };
}

/** The sum of a population's counts over the samples, with the root's own total as the parent of the root. */
function populationViews(state: CoreState, samples: readonly { id: string; gating: GatingDerived; events: number }[]): AgentPopulation[] {
  const rootId = state.root_population_id;
  if (!rootId) return [];
  const total = samples.reduce((sum, s) => sum + s.events, 0);
  return populationTreeOrder(state.populations, rootId).map(({ popId, depth }) => {
    const population = state.populations[popId];
    const counts = samples.map((s) => {
      const n = s.gating.stats.event_count[popId] ?? 0;
      const parentN = population.parent_id ? (s.gating.stats.event_count[population.parent_id] ?? 0) : s.events;
      return { sampleId: s.id, n, parentN, percentOfParent: parentN ? (100 * n) / parentN : null };
    });
    const n = counts.reduce((sum, c) => sum + c.n, 0);
    const parentN = counts.reduce((sum, c) => sum + c.parentN, 0);
    return {
      id: popId, name: population.name, parentId: population.parent_id, depth,
      gates: population.gate_refs.map((ref) => ({ gateId: ref.gate_id, include: ref.include, ...(ref.quadrant === undefined || ref.quadrant === null ? {} : { quadrant: ref.quadrant }) })),
      counts,
      pooled: { n, parentN, percentOfParent: parentN ? (100 * n) / parentN : null, percentOfTotal: total ? (100 * n) / total : 0 },
    };
  });
}

/** Linearly interpolated quantiles of a sorted array. */
function quantilesOf(sorted: Float64Array): Record<string, number> {
  const out: Record<string, number> = {};
  const last = sorted.length - 1;
  for (const p of QUANTILES) {
    if (last < 0) { out[String(p)] = NaN; continue; }
    const pos = p * last;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    out[String(p)] = sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }
  return out;
}

function axisDistribution(channel: string, transform: AgentChannel["transform"], values: Float64Array, bins: number, range?: [number, number]): AgentAxisDistribution {
  const sorted = Float64Array.from(values).sort();
  const min = sorted.length ? sorted[0] : 0, max = sorted.length ? sorted[sorted.length - 1] : 0;
  let [lo, hi] = range ?? [min, max];
  if (!(hi > lo)) hi = lo + 1;
  const edges = Array.from({ length: bins + 1 }, (_, i) => lo + ((hi - lo) * i) / bins);
  const counts = new Array<number>(bins).fill(0);
  const scale = bins / (hi - lo);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    sum += v;
    if (v < lo || v > hi) continue;
    counts[Math.min(bins - 1, Math.floor((v - lo) * scale))]++;
  }
  return { channel, transform, min, max, edges, counts, quantiles: quantilesOf(sorted), mean: values.length ? sum / values.length : NaN, valleys: valleysOf(counts, edges) };
}

/**
 * The antimodes of a histogram: local minima of the three-bin-smoothed counts that have a mode on
 * either side, deepest first (depth = the smaller of the two neighbouring modes' heights above the
 * minimum, relative to the taller mode), at most three, at the bin's midpoint. A threshold between
 * two populations is one of these; a single mode gives none.
 */
export function valleysOf(counts: readonly number[], edges: readonly number[]): number[] {
  const n = counts.length;
  if (n < 5) return [];
  const smooth = counts.map((_, i) => (i === 0 || i === n - 1 ? counts[i] : (counts[i - 1] + counts[i] + counts[i + 1]) / 3));
  const peaks: number[] = [];
  for (let i = 1; i < n - 1; i++) if (smooth[i] > smooth[i - 1] && smooth[i] >= smooth[i + 1] && smooth[i] > 0) peaks.push(i);
  if (smooth[0] > smooth[1]) peaks.unshift(0);
  if (smooth[n - 1] > smooth[n - 2]) peaks.push(n - 1);
  const valleys: { at: number; depth: number }[] = [];
  for (let p = 0; p + 1 < peaks.length; p++) {
    let low = peaks[p];
    for (let i = peaks[p]; i <= peaks[p + 1]; i++) if (smooth[i] < smooth[low]) low = i;
    const left = smooth[peaks[p]], right = smooth[peaks[p + 1]];
    const depth = (Math.min(left, right) - smooth[low]) / Math.max(left, right);
    // A dip of less than a tenth of the neighbouring modes is noise, not a valley.
    if (depth >= 0.1) valleys.push({ at: (edges[low] + edges[low + 1]) / 2, depth });
  }
  return valleys.sort((a, b) => b.depth - a.depth).slice(0, 3).map((v) => v.at);
}

export function createAgentHandler(adapter: AgentAdapter): AgentHandler {
  let lastState: CoreState | null = null;
  let rev = 0;
  const revision = () => {
    const state = adapter.state();
    if (state !== lastState) { lastState = state; rev++; }
    return rev;
  };

  const loaded = () => adapter.samples().map((view) => ({ view, gating: view.gating(), events: view.sample.fcs.nEvents }));
  const sampleInfo = (s: ReturnType<typeof loaded>[number]): AgentSampleInfo => ({ id: s.view.id, name: s.view.name, events: s.events, viewed: s.view.viewed, checked: s.view.checked, metadata: { ...s.view.metadata } });
  const populationsOf = (state: CoreState, all: ReturnType<typeof loaded>) => populationViews(state, all.map((s) => ({ id: s.view.id, gating: s.gating, events: s.events })));
  const gatesOf = (state: CoreState) => (state.gate_order.length ? state.gate_order : Object.keys(state.gates)).map((id) => state.gates[id]).filter(Boolean).map(gateView);

  /** The sample whose channels and transforms stand for the data: the viewed one, else the first. */
  const reference = (all: ReturnType<typeof loaded>) => all.find((s) => s.view.viewed) ?? all[0] ?? null;

  const channelsOf = (sample: Sample): AgentChannel[] =>
    sample.channels.map((channel, idx) => ({
      key: channel.key, label: sample.channelLabel(idx), pnn: channel.pnn, marker: channel.marker,
      kind: channelKind(sample, idx), transform: sample.transformSpec(channel.key),
    }));

  const commandContext = (state: CoreState, all: ReturnType<typeof loaded>, provenance: GateProvenance) => {
    const ref = reference(all);
    const channels = new Set<string>(ref ? ref.view.sample.channels.map((c) => c.key) : []);
    const transformsFor = (x: string, y: string): GateTransforms => {
      if (!ref) throw new AgentCommandError("No data is loaded.");
      return { [x]: ref.view.sample.transformSpec(x), [y]: ref.view.sample.transformSpec(y) };
    };
    // The data's extent on a channel over every loaded sample, a little past the last event, so an
    // open side of a range takes every event and is still drawn within the chart.
    const dataEdge = (channel: string, space: "raw" | "display"): [number, number] => {
      let lo = Infinity, hi = -Infinity;
      for (const s of all) {
        const idx = s.view.sample.index(channel);
        if (idx === undefined) continue;
        const column = space === "display" ? s.view.sample.displayColumn(idx) : s.view.sample.rawColumnData(idx);
        for (let i = 0; i < column.length; i++) {
          const v = column[i];
          if (!Number.isFinite(v)) continue;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      if (!(hi >= lo)) throw new AgentCommandError(`No finite values on “${channel}”.`);
      const pad = Math.max(hi - lo, 1) * 0.02;
      return [lo - pad, hi + pad];
    };
    return { state, channels, transformsFor, dataEdge, provenance };
  };

  /** The gating of every sample under a state other than the app's: a preview. */
  const gatingUnder = (next: CoreState, all: ReturnType<typeof loaded>) => {
    const trees = workspaceHierarchyTrees(next);
    return all.map((s) => {
      const tree = trees.find((t) => t.id === s.view.hierarchyId) ?? trees.find((t) => t.active) ?? null;
      const gating = tree && !tree.active ? recomputeGating(s.view.sample, gatingStateForTree(next, tree)) : recomputeGating(s.view.sample, next);
      return { ...s, gating };
    });
  };

  /** The samples a series selection names, and the population it reads. */
  const selection = (state: CoreState, all: ReturnType<typeof loaded>, params: AgentSeriesSelection) => {
    const populationId = typeof params.populationId === "string" && params.populationId ? params.populationId : state.root_population_id;
    if (!populationId || !state.populations[populationId]) throw new AgentCommandError(`Unknown population “${String(params.populationId)}”.`);
    const ids = stringList(params.sampleIds, "sampleIds");
    let chosen: ReturnType<typeof loaded>;
    if (ids) {
      chosen = ids.map((id) => {
        const found = all.find((s) => s.view.id === id);
        if (!found) throw new AgentCommandError(`Unknown sample “${id}”.`);
        return found;
      });
    } else if (params.pooled) {
      chosen = all.filter((s) => s.view.checked);
      if (!chosen.length) chosen = all;
    } else {
      const ref = reference(all);
      chosen = ref ? [ref] : [];
    }
    if (!chosen.length) throw new AgentCommandError("No data is loaded.");
    return { populationId, chosen, pooled: !!params.pooled };
  };

  const describe = (): AgentDescribe => {
    const state = adapter.state();
    const all = loaded();
    const ref = reference(all);
    return {
      revision: revision(), host: adapter.info(),
      channels: ref ? channelsOf(ref.view.sample) : [],
      samples: all.map(sampleInfo),
      rootPopulationId: state.root_population_id,
      populations: populationsOf(state, all),
      gates: gatesOf(state),
      view: adapter.view(),
    };
  };

  const distribution = (raw: unknown): AgentDistribution => {
    const params = record(raw) as unknown as AgentDistributionParams;
    const state = adapter.state();
    const all = loaded();
    const { populationId, chosen, pooled } = selection(state, all, params);
    const bins = params.bins === undefined ? 64 : params.bins;
    if (!Number.isInteger(bins) || bins < 2 || bins > 256) throw new AgentCommandError("bins must be an integer from 2 to 256.");
    const x = typeof params.x === "string" ? params.x : "";
    const y = typeof params.y === "string" ? params.y : undefined;
    const range = record(params.range) as { x?: [number, number]; y?: [number, number] };
    const check = (r: unknown, label: string): [number, number] | undefined => {
      if (r === undefined) return undefined;
      if (!Array.isArray(r) || r.length !== 2 || r.some((v) => typeof v !== "number" || !Number.isFinite(v)) || !(r[1] > r[0])) throw new AgentCommandError(`range.${label} must be [low, high] with low below high.`);
      return [r[0], r[1]];
    };
    const xRange = check(range.x, "x"), yRange = check(range.y, "y");
    // Gather each series' finite values on the axes, then bin.
    const groups: { series: string; parts: ReturnType<typeof loaded> }[] = pooled
      ? [{ series: "pooled", parts: chosen }]
      : chosen.map((s) => ({ series: s.view.id, parts: [s] }));
    const series: AgentDistributionSeries[] = groups.map((group) => {
      const xs: number[] = [], ys: number[] = [];
      let dropped = 0;
      let transformX: AgentChannel["transform"] | null = null, transformY: AgentChannel["transform"] | null = null;
      for (const s of group.parts) {
        const sample = s.view.sample;
        const xi = sample.index(x);
        const yi = y === undefined ? undefined : sample.index(y);
        if (xi === undefined) throw new AgentCommandError(`Unknown channel “${x}”.`);
        if (y !== undefined && yi === undefined) throw new AgentCommandError(`Unknown channel “${y}”.`);
        if (y !== undefined && yi === xi) throw new AgentCommandError("x and y must be two different channels.");
        transformX ??= sample.transformSpec(x);
        if (y !== undefined) transformY ??= sample.transformSpec(y);
        const mask = s.gating.masks[populationId];
        const cx = sample.displayColumn(xi);
        const cy = yi === undefined ? null : sample.displayColumn(yi);
        for (let i = 0; i < cx.length; i++) {
          if (mask && !mask[i]) continue;
          const vx = cx[i], vy = cy ? cy[i] : 0;
          if (!Number.isFinite(vx) || !Number.isFinite(vy)) { dropped++; continue; }
          xs.push(vx);
          if (cy) ys.push(vy);
        }
      }
      const xv = Float64Array.from(xs);
      const out: AgentDistributionSeries = {
        series: group.series, n: xv.length, dropped,
        x: axisDistribution(x, transformX!, xv, bins, xRange),
      };
      if (y !== undefined) {
        const yv = Float64Array.from(ys);
        out.y = axisDistribution(y, transformY!, yv, bins, yRange);
        const grid = new Array<number>(bins * bins).fill(0);
        const [xlo, xhi] = [out.x.edges[0], out.x.edges[bins]];
        const [ylo, yhi] = [out.y.edges[0], out.y.edges[bins]];
        const sx = bins / (xhi - xlo), sy = bins / (yhi - ylo);
        for (let i = 0; i < xv.length; i++) {
          const vx = xv[i], vy = yv[i];
          if (vx < xlo || vx > xhi || vy < ylo || vy > yhi) continue;
          grid[Math.min(bins - 1, Math.floor((vy - ylo) * sy)) * bins + Math.min(bins - 1, Math.floor((vx - xlo) * sx))]++;
        }
        out.grid = grid;
      }
      return out;
    });
    return { revision: revision(), populationId, bins, series };
  };

  const stats = (raw: unknown): AgentStats => {
    const params = record(raw) as unknown as AgentStatsParams;
    const state = adapter.state();
    const all = loaded();
    const populationIds = stringList(params.populationIds, "populationIds") ?? populationTreeOrder(state.populations, state.root_population_id).map((p) => p.popId);
    for (const id of populationIds) if (!state.populations[id]) throw new AgentCommandError(`Unknown population “${id}”.`);
    const channels = stringList(params.channels, "channels");
    const thresholds = record(params.thresholds) as Record<string, unknown>;
    for (const [key, value] of Object.entries(thresholds)) if (typeof value !== "number" || !Number.isFinite(value)) throw new AgentCommandError(`thresholds.${key} must be a finite number.`);
    const ids = stringList(params.sampleIds, "sampleIds");
    const chosen = ids
      ? ids.map((id) => { const f = all.find((s) => s.view.id === id); if (!f) throw new AgentCommandError(`Unknown sample “${id}”.`); return f; })
      : params.pooled ? (all.filter((s) => s.view.checked).length ? all.filter((s) => s.view.checked) : all) : (reference(all) ? [reference(all)!] : []);
    if (!chosen.length) throw new AgentCommandError("No data is loaded.");
    const ref = chosen[0].view.sample;
    const keys = [...new Set([...(channels ?? ref.channels.map((c) => c.key)), ...Object.keys(thresholds)])];
    for (const key of keys) if (ref.index(key) === undefined) throw new AgentCommandError(`Unknown channel “${key}”.`);
    const groups = params.pooled ? [{ series: "pooled", parts: chosen }] : chosen.map((s) => ({ series: s.view.id, parts: [s] }));
    const populations: AgentPopulationStats[] = [];
    for (const popId of populationIds) {
      for (const group of groups) {
        let n = 0;
        for (const s of group.parts) n += s.gating.stats.event_count[popId] ?? 0;
        const stride = Math.max(1, Math.ceil(n / STATS_SAMPLE));
        const medians: Record<string, number | null> = {};
        const positive: Record<string, number | null> = {};
        for (const key of keys) {
          const values: number[] = [];
          const threshold = thresholds[key] as number | undefined;
          let seen = 0, above = 0, finite = 0;
          for (const s of group.parts) {
            const sample = s.view.sample;
            const idx = sample.index(key);
            if (idx === undefined) continue;
            const column = sample.displayColumn(idx);
            const mask = s.gating.masks[popId];
            for (let i = 0; i < column.length; i++) {
              if (mask && !mask[i]) continue;
              const v = column[i];
              // The fraction above a threshold is over every event; the median over the sample.
              if (threshold !== undefined && Number.isFinite(v)) { finite++; if (v >= threshold) above++; }
              if (seen++ % stride) continue;
              if (Number.isFinite(v)) values.push(v);
            }
          }
          const sorted = Float64Array.from(values).sort();
          medians[key] = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : null;
          if (threshold !== undefined) positive[key] = finite ? above / finite : null;
        }
        populations.push({ populationId: popId, series: group.series, n, sampled: stride > 1, medians, ...(Object.keys(positive).length ? { positive } : {}) });
      }
    }
    return { revision: revision(), populations };
  };

  const provenanceFor = (rationale: string): GateProvenance => ({ by: writerName, rationale, at: new Date().toISOString() });
  let writerName = "agent";

  const preview = (raw: unknown): AgentPreview => {
    const params = record(raw) as unknown as AgentPreviewParams;
    const state = adapter.state();
    const all = loaded();
    const action = commandToAction(params.command as AgentCommand, commandContext(state, all, provenanceFor("preview")));
    const next = coreReducer(state, action);
    const after = gatingUnder(next, all);
    return {
      revision: revision(),
      populations: populationsOf(next, after).map((p) => ({ ...p, isNew: !state.populations[p.id] })),
      gates: gatesOf(next).map((g) => ({ ...g, isNew: !state.gates[g.id] })),
    };
  };

  const apply = async (raw: unknown): Promise<AgentApplied | AgentError> => {
    const params = record(raw) as unknown as AgentApplyParams;
    const current = revision();
    if (params.expectedRevision !== undefined && params.expectedRevision !== current) {
      return fail("conflict", `The gating has moved: revision ${current}, not ${String(params.expectedRevision)}.`, current);
    }
    if (typeof params.rationale !== "string" || !params.rationale.trim()) throw new AgentCommandError("A rationale is required.");
    const state = adapter.state();
    const all = loaded();
    const action = commandToAction(params.command as AgentCommand, commandContext(state, all, provenanceFor(params.rationale.trim())));
    adapter.dispatch(action);
    await adapter.settled();
    const next = adapter.state();
    const after = loaded();
    return {
      revision: revision(),
      populations: populationsOf(next, after),
      gates: gatesOf(next),
      created: {
        gateIds: Object.keys(next.gates).filter((id) => !state.gates[id]),
        populationIds: Object.keys(next.populations).filter((id) => !state.populations[id]),
      },
    };
  };

  const view = async (raw: unknown): Promise<AgentView> => {
    const params = record(raw) as AgentViewParams;
    const state = adapter.state();
    const all = loaded();
    if (params.populationId !== undefined && !state.populations[params.populationId]) throw new AgentCommandError(`Unknown population “${params.populationId}”.`);
    if (params.sampleId !== undefined && !all.some((s) => s.view.id === params.sampleId)) throw new AgentCommandError(`Unknown sample “${params.sampleId}”.`);
    const ref = reference(all);
    for (const key of [params.x, params.y]) if (key !== undefined && (!ref || ref.view.sample.index(key) === undefined)) throw new AgentCommandError(`Unknown channel “${key}”.`);
    const checkRange = (r: unknown, label: string): [number, number] | undefined => {
      if (r === undefined) return undefined;
      if (!Array.isArray(r) || r.length !== 2 || r.some((v) => typeof v !== "number" || !Number.isFinite(v)) || !(r[1] > r[0])) throw new AgentCommandError(`${label} must be [low, high] with low below high.`);
      return [r[0], r[1]];
    };
    const xRange = checkRange(params.xRange, "xRange"), yRange = checkRange(params.yRange, "yRange");
    if (params.fit !== undefined && params.fit !== true && params.fit !== false && params.fit !== "data") throw new AgentCommandError('fit must be true, false or "data".');
    await adapter.setView(params);
    const after = adapter.view();
    if (params.fit === true) {
      // The fit reads the axes as they are after the view settled. A pan the plot reports in the
      // same tick would put the old frame back over the fitted one (seen once on a 69-sample
      // object, 2026-10-06), so the pan is dropped again once the fit has settled.
      adapter.fit();
      await adapter.settled();
    } else if (params.fit === "data" && after.x && after.y) {
      // The whole of the data on each axis, every sample, widened to the gates drawn on these two
      // channels: a frame that cuts nothing off, where the Fit button's percentile frame can drop
      // the pile at zero of an arcsinh axis.
      const state = adapter.state();
      for (const key of [after.x, after.y]) {
        let [lo, hi] = commandContext(state, all, provenanceFor("fit")).dataEdge(key, "display");
        for (const gate of Object.values(state.gates)) {
          if (!((gate.x_channel === after.x && gate.y_channel === after.y) || (gate.x_channel === after.y && gate.y_channel === after.x))) continue;
          const own = (gate.x_channel === key ? 0 : 1) as 0 | 1;
          const points = gate.gate_type === "quadrant" ? [gate.center] : gate.gate_type === "ellipse" ? [gate.mean] : gate.vertices;
          for (const point of points) {
            const v = ref ? ref.view.sample.gateToDisplay(gate, key, point[own]) : point[own];
            if (!Number.isFinite(v) || Math.abs(v) >= 1e9) continue;
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
        adapter.setAxisRange(key, [lo, hi]);
      }
      await adapter.settled();
    }
    if (xRange && after.x) adapter.setAxisRange(after.x, xRange);
    if (yRange && after.y) adapter.setAxisRange(after.y, yRange);
    if (params.fit || xRange || yRange) {
      await adapter.settled();
      adapter.clearPan();
      await adapter.settled();
    }
    return adapter.view();
  };

  const render = async (raw: unknown): Promise<AgentRender> => {
    const params = record(raw) as AgentRenderParams;
    const image = await adapter.render(params);
    return { revision: revision(), view: adapter.view(), ...image };
  };

  const memberships = (raw: unknown): AgentMemberships => {
    const params = record(raw) as AgentMembershipsParams;
    const state = adapter.state();
    const all = loaded();
    const wanted = stringList(params.populationIds, "populationIds");
    const built = buildHostedMemberships(state, all.map((s) => ({
      sampleId: s.view.id, eventCount: s.events, name: s.view.name, hierarchyId: s.view.hierarchyId,
      gatingFor: (tree: HierarchyTree) => (tree.id === s.view.hierarchyId ? s.gating : recomputeGating(s.view.sample, gatingStateForTree(state, tree))),
    })));
    return {
      revision: revision(),
      samples: all.map(sampleInfo),
      populations: built.populations
        .filter((p) => !wanted || wanted.includes(p.populationId))
        .map((p) => ({
          id: p.populationId, name: p.populationName, hierarchyId: p.hierarchyId,
          sampleMasks: p.sampleMasks.map((m) => ({ sampleId: m.sampleId, eventCount: m.eventCount, membershipBitsBase64: m.membershipBitsBase64 })),
        })),
    };
  };

  const workspace = (): AgentWorkspace => ({ revision: revision(), json: adapter.workspaceJson() });

  const reload = (): { reloading: true } => {
    // After the reply has gone out: the tab comes back with the core now installed under it, and
    // the gating as the host last autosaved it, and reconnects through the address on its URL.
    setTimeout(() => adapter.reload(), 200);
    return { reloading: true };
  };

  return {
    revision,
    async handle(request) {
      const reply = (result: unknown): AgentResponse => ({ kind: "response", id: request.id, result });
      const refused = (error: AgentError): AgentResponse => ({ kind: "response", id: request.id, error });
      try {
        switch (request.method) {
          case "describe": return reply(describe());
          case "distribution": return reply(distribution(request.params));
          case "stats": return reply(stats(request.params));
          case "preview": return reply(preview(request.params));
          case "apply": {
            const result = await apply(request.params);
            return "code" in result ? refused(result) : reply(result);
          }
          case "view": return reply(await view(request.params));
          case "render": return reply(await render(request.params));
          case "memberships": return reply(memberships(request.params));
          case "workspace": return reply(workspace());
          case "reload": return reply(reload());
          default: return refused(fail("unknown-method", `Unknown method “${String((request as { method?: unknown }).method)}”.`));
        }
      } catch (error) {
        if (error instanceof AgentCommandError) return refused(fail("refused", error.message));
        return refused(fail("failed", error instanceof Error ? error.message : String(error)));
      }
    },
    setWriter(name: string) { writerName = name || "agent"; },
  };
}
