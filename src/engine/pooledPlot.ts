// pooledPlot.ts — one plot of several files' events. The Illustration tab's pooled panels and
// the Layout tab's pooled plots draw by the rules here, so a pool looks the same in both: the
// point cap is shared out as the Gating tab shares it, the counts are summed, and a gate is
// drawn only where every pooled file has it alike, with the percentage pooled over the files.

import type { GatingDerived } from "../store";
import { canonicalGateId, type StoredHierarchy } from "./hierarchies";
import { buildIllustrationPayload, type GateOverlay, type IllustrationOptions } from "./illustration";
import type { Gate } from "./models";
import { allocateCombinedSampleCaps } from "./multiSamplePlot";
import type { Sample } from "./sample";

/**
 * A gate's shape, without what does not move an event: its id, name, colour and where its
 * labels sit. Two gates with one key select the same events on the same data.
 */
export function gateGeometryKey(gate: unknown): string {
  return JSON.stringify(gate, (key, value) =>
    ["gate_id", "name", "color", "label_offset", "quadrant_label_offsets"].includes(key)
      ? undefined
      : value,
  );
}

/** The gates of a tree drawn on a plot of `x` against `y`, in either orientation, in gate order. */
function gatesOnPlot(tree: StoredHierarchy, x: string, y: string): Gate[] {
  const ids = tree.gate_order.length ? tree.gate_order : Object.keys(tree.gates);
  return ids
    .map((id) => tree.gates[id])
    .filter((gate): gate is Gate =>
      !!gate &&
      ((gate.x_channel === x && gate.y_channel === y) || (gate.x_channel === y && gate.y_channel === x)));
}

/**
 * Which of the first tree's gates on the plot every other tree holds alike: the same gate by
 * lineage (`canonicalGateId`) with the same geometry. A gate a copy tailored, deleted or never
 * had is omitted, named, so a pooled plot never draws one file's boundary over another's events.
 */
export function pooledGateAgreement(
  trees: Record<string, StoredHierarchy>,
  memberTreeIds: readonly string[],
  x: string,
  y: string | null,
): { agreed: string[]; omitted: { gateId: string; name: string }[] } {
  const reference = trees[memberTreeIds[0] ?? ""];
  if (!reference || !y) return { agreed: [], omitted: [] };
  const others = [...new Set(memberTreeIds.slice(1))]
    .map((id) => trees[id])
    .filter((tree): tree is StoredHierarchy => !!tree && tree.id !== reference.id);
  const agreed: string[] = [];
  const omitted: { gateId: string; name: string }[] = [];
  for (const gate of gatesOnPlot(reference, x, y)) {
    const canonical = canonicalGateId(gate.gate_id, reference, trees);
    const shape = gateGeometryKey(gate);
    const alike = others.every((tree) => {
      const match = Object.values(tree.gates).find((candidate) => canonicalGateId(candidate.gate_id, tree, trees) === canonical);
      return !!match && gateGeometryKey(match) === shape;
    });
    if (alike) agreed.push(canonical);
    else omitted.push({ gateId: gate.gate_id, name: gate.name });
  }
  return { agreed, omitted };
}

/** One pooled file's part of a plot: its tree, the gate overlays drawn for it, and how many events its population holds. */
export interface PooledGatePart {
  tree: StoredHierarchy;
  gates: readonly GateOverlay[];
  populationCount: number;
}

/**
 * The first part's overlays for the agreed gates, each labelled with the percentage pooled over
 * every part: the events inside the gate in all the files over the population in all the files,
 * as the Gating tab labels a pooled cloud. Quadrant counts are summed the same way.
 */
export function pooledGateOverlays(
  parts: readonly PooledGatePart[],
  trees: Record<string, StoredHierarchy>,
  agreed: ReadonlySet<string>,
): GateOverlay[] {
  const reference = parts[0];
  if (!reference) return [];
  const parentCount = parts.reduce((total, part) => total + Math.max(0, part.populationCount), 0);
  const round2 = (value: number) => Math.round(value * 100) / 100;
  const percent = (count: number) => (parentCount > 0 ? round2((count / parentCount) * 100) : 0);
  const out: GateOverlay[] = [];
  for (const overlay of reference.gates) {
    const canonical = canonicalGateId(overlay.gate_id, reference.tree, trees);
    if (!agreed.has(canonical)) continue;
    const counterparts = parts.map((part) =>
      part === reference
        ? overlay
        : part.gates.find((candidate) => canonicalGateId(candidate.gate_id, part.tree, trees) === canonical));
    if (overlay.gate_type === "quadrant") {
      const quadrantCounts = (overlay.quadrant_counts ?? []).map((_, index) =>
        counterparts.reduce((total, part) => total + (part?.quadrant_counts?.[index] ?? 0), 0));
      out.push({ ...overlay, quadrant_counts: quadrantCounts, quadrant_pcts: quadrantCounts.map(percent) });
      continue;
    }
    const inside = counterparts.reduce((total, part) => total + (part?.event_count ?? 0), 0);
    out.push({ ...overlay, event_count: inside, percent_of_parent: percent(inside) });
  }
  return out;
}

/**
 * Why a file cannot join a pool drawn on the reference file's channels, or null when it can: the
 * pool is one cloud on one pair of axes, so every file must hold the channels under the same
 * identities and be drawn from the same assay layer.
 */
export function poolCompatibility(reference: Sample, other: Sample, x: string, y: string | null): string | null {
  if (other.activeLayer !== reference.activeLayer) return "different assay layer";
  for (const key of y ? [x, y] : [x]) {
    const index = other.index(key);
    if (index === undefined) return `channel ${key} unavailable`;
    const referenceIndex = reference.index(key);
    const a = other.channels[index];
    const b = referenceIndex === undefined ? undefined : reference.channels[referenceIndex];
    if (!b || a.marker !== b.marker || a.pnn !== b.pnn) return "different channel identities";
  }
  return null;
}

/** One file of a pool, prepared: gated under its tree, with the population the plot shows resolved in that tree. */
export interface PooledMember {
  id: string;
  name: string;
  sample: Sample;
  tree: StoredHierarchy;
  gating: GatingDerived;
  populationId: string;
}

export interface PooledPlotPayload {
  /** The mini-plot configuration: the first member's axes with every member's points and the summed count. */
  config: Record<string, unknown>;
  /** The gates every member holds alike, with pooled percentages. */
  gates: GateOverlay[];
  /** The names of the first member's gates on the plot that the others do not hold alike. */
  omittedGates: string[];
  /** The population's events over every member. */
  count: number;
}

/**
 * A plot of the members' events pooled. The point cap is shared out in proportion to each
 * member's population by largest remainders (`allocateCombinedSampleCaps`), so the pool never
 * exceeds it; the counts use every event. The first member is the reference: its axes, ticks
 * and labels, and its gates where the others agree.
 */
export function buildPooledPlotPayload(
  members: readonly PooledMember[],
  x: string,
  y: string | null,
  globalScales: Record<string, [number, number]>,
  opts: IllustrationOptions,
  trees: Record<string, StoredHierarchy>,
): PooledPlotPayload | null {
  if (!members.length) return null;
  const counts = members.map((member) => Math.max(0, member.gating.stats.event_count[member.populationId] ?? 0));
  const caps = Number.isFinite(opts.maxEvents) && opts.maxEvents > 0
    ? allocateCombinedSampleCaps(counts, opts.maxEvents)
    : counts;
  const key = (member: PooledMember) => `${member.populationId}|${x}`;
  const parts: { member: PooledMember; config: Record<string, unknown>; gates: GateOverlay[] }[] = [];
  members.forEach((member, index) => {
    const result = buildIllustrationPayload(
      member.sample,
      member.tree.gates,
      member.tree.gate_order,
      member.tree.populations,
      member.gating.masks,
      member.gating.stats.event_count,
      [member.populationId],
      [x],
      y,
      globalScales,
      // A cap of zero would mean every event to the sampler; a member whose share rounds to
      // nothing contributes one point rather than all of them.
      { ...opts, maxEvents: counts[index] > 0 ? Math.max(1, caps[index]) : 1, includeEmpty: true, pointBudget: Infinity },
      member.gating.gateMasks,
    ) as { plots?: Record<string, Record<string, unknown>>; gate_overlays?: Record<string, GateOverlay[]> };
    const config = result.plots?.[key(member)];
    if (!config) return;
    parts.push({ member, config, gates: result.gate_overlays?.[key(member)] ?? [] });
  });
  if (!parts.length) return null;
  const agreement = pooledGateAgreement(trees, parts.map((part) => part.member.tree.id), x, y);
  const gates = pooledGateOverlays(
    parts.map((part) => ({
      tree: part.member.tree,
      gates: part.gates,
      populationCount: part.member.gating.stats.event_count[part.member.populationId] ?? 0,
    })),
    trees,
    new Set(agreement.agreed),
  );
  const count = counts.reduce((total, value) => total + value, 0);
  return {
    config: {
      ...parts[0].config,
      x: parts.flatMap((part) => part.config.x as number[]),
      y: parts.flatMap((part) => (part.config.y as number[] | undefined) ?? []),
      n_events: count,
    },
    gates,
    omittedGates: agreement.omitted.map((gate) => gate.name),
    count,
  };
}
