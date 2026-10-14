// hostedHierarchy.ts — a flowWorkspace GatingSet's hierarchy, as GateLabR describes it, turned
// into GateLab gates and populations at open.
//
// A GatingSet keeps its gates with the data: each node is a gate evaluated in the transformed
// space of its two channels, or a boolean of other nodes, and the object holds each channel's
// transform. GateLabR reads the nodes and the transform parameters from the object and sends
// them here as JSON, with every gate's geometry in the space it is evaluated in and that space
// named as a TransformSpec per axis. The translation below keeps that: every gate is a
// display-space gate carrying its transforms (models.ts, GateSpace), so the app tests events
// through the same transform flowWorkspace did and finds the same events, whatever axis the
// user later looks at.
//
// Gating-ML was not the carrier because CytoML's export refuses FlowJo's log transform and has
// no form for its biexponential, which a GatingSet parsed from a FlowJo workspace holds on every
// fluorescence channel. GateLabR maps the object's fasinh and log to the app's asinh and wsplog,
// which are the same functions up to an affine map, and maps the geometry with them, so the gate
// arrives exact; a biexponential arrives by its parameters with no tableChannels, which selects
// cytolib's own table, flowWorkspace's function (design note of 2026-10-13).
//
// A GatingSet keeps each sample's own gates, and a GatingSet parsed from a FlowJo workspace has
// them tailored per sample. GateLabR sends each node's gate as the tree's (the one most samples
// hold) and, for every sample whose gate differs, that sample's own as `tailored`; such a sample
// opens with a tailored copy of the tree carrying its gates, as a FlowJo workspace's tailored
// samples open (oneTreeImport.ts), so each sample is gated by its own gates and its counts are
// flowWorkspace's. Contract 1 had no tailoring: every sample was gated by the first sample's
// gates, and a node tailored in FlowJo counted other events than the object on every other sample.

import type { Gate, GateRef, GateTransforms, Population, PopulationMap, TransformSpec, Vertex } from "../engine/models";
import { nextGateColor, UNBOUNDED } from "../engine/models";
import { DEFAULT_HIERARCHY_ID, DEFAULT_HIERARCHY_NAME, uniqueHierarchyName, type HierarchyRef } from "../engine/hierarchies";
import { validateWorkspace, WORKSPACE_FORMAT, type WorkspaceFile, type WorkspaceStoredHierarchy } from "../engine/workspace";
import type { GateLabHostDatasetDescriptor } from "./datasetContract";

/** 2 adds per-sample gates (`tailored`); a reader of 1 would gate every sample by the tree's. */
export const GATELAB_HOST_HIERARCHY_CONTRACT_VERSION = 2 as const;
/** The contracts this GateLab reads: 1 is 2 with no node tailored. */
const READABLE_CONTRACTS: readonly number[] = [1, 2];

/** One axis of a gate: the channel, and the transform its coordinates are in; null is the linear value. */
export interface HostedHierarchyAxis {
  channel: string;
  transform: TransformSpec | null;
}

/**
 * A node's gate, in the space its axes name. A rectangle may be one-dimensional (a range gate),
 * and a bound of null is no bound on that side. An ellipse is flowCore's: mean, covariance and
 * the Mahalanobis distance, not its square. A quadrant set is flowWorkspace's quadGate, whose
 * four children the host found as four open rectangles sharing one centre; its members are the
 * populations, numbered as the app numbers quadrants (gates.ts: 1 = x−/y+, 2 = x+/y+,
 * 3 = x+/y−, 4 = x−/y−).
 */
export type HostedHierarchyGate =
  | { kind: "rectangle"; axes: readonly HostedHierarchyAxis[]; min: readonly (number | null)[]; max: readonly (number | null)[] }
  | { kind: "polygon"; axes: readonly HostedHierarchyAxis[]; vertices: readonly (readonly [number, number])[] }
  | {
      kind: "ellipse";
      axes: readonly HostedHierarchyAxis[];
      mean: readonly [number, number];
      covariance: readonly [readonly [number, number], readonly [number, number]];
      distance: number;
    }
  | {
      kind: "quadrant";
      axes: readonly HostedHierarchyAxis[];
      center: readonly [number, number];
      members: readonly Readonly<{ path: string; name: string; quadrant: number }>[];
    };

/** A node of the hierarchy. `path` is its full path and its identity; `parent` is the parent's path, or "root". */
export interface HostedHierarchyNode {
  path: string;
  name: string;
  parent: string;
  /** Added with `negated = TRUE`: the parent's events outside the gate. */
  negated?: boolean;
  gate?: HostedHierarchyGate;
  /**
   * The samples whose own gate for this node differs from `gate`, each with its gate, of the same
   * form (a quadrant set stays a quadrant set with the same members). Absent when every sample
   * holds `gate`. A sample is the dataset's sample id.
   */
  tailored?: readonly Readonly<{ sample: string; gate: HostedHierarchyGate }>[];
  /** A booleanFilter over other nodes, resolved by the host to paths. */
  boolean?: { operator: "and" | "or"; refs: readonly Readonly<{ path: string; include: boolean }>[] };
}

export interface HostedHierarchy {
  contractVersion: 1 | typeof GATELAB_HOST_HIERARCHY_CONTRACT_VERSION;
  nodes: readonly HostedHierarchyNode[];
  /** Nodes the host could not describe (a calibration-table transform, for one), with the reason. */
  leftOut?: readonly Readonly<{ path: string; reason: string }>[];
}

export interface HostedHierarchyTranslation {
  workspace: WorkspaceFile;
  /** Every node not restored, as "path: reason", for the status line. */
  leftOut: readonly string[];
  /** Each sample opened with gates of its own, in the dataset's order, with how many: for the status line. */
  tailoring: readonly Readonly<{ sample: string; gates: number }>[];
}

/** The hierarchy a sample's tailored copy of the tree is: one per sample with a gate of its own. */
export function tailoredHierarchyId(sampleId: string): string {
  return `gatingset-tailoring:${sampleId}`;
}

export const ROOT_POPULATION_ID = "root";

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`The GatingSet hierarchy has a malformed ${label}.`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`The GatingSet hierarchy has a malformed ${label}.`);
  return value;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`The GatingSet hierarchy has a malformed ${label}.`);
  }
  return value;
}

function list(value: unknown, label: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  // R's auto-unboxing turns a one-item list into its item and a length-one vector into a scalar.
  if (typeof value === "object" || typeof value === "number" || typeof value === "string" || typeof value === "boolean") return [value];
  throw new Error(`The GatingSet hierarchy has a malformed ${label}.`);
}

/** The vertices of a rectangle from its bounds; an absent bound holds every value on that side. */
function rectangleVertices(xlo: number | null, xhi: number | null, ylo: number | null, yhi: number | null): Vertex[] {
  const x0 = xlo ?? -UNBOUNDED;
  const x1 = xhi ?? UNBOUNDED;
  const y0 = ylo ?? -UNBOUNDED;
  const y1 = yhi ?? UNBOUNDED;
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

function bound(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  return finite(value, label);
}

/** A gate's transforms, by channel: an axis without a transform is evaluated on the linear value. */
function gateTransforms(
  axes: readonly HostedHierarchyAxis[],
  readSpec: (value: unknown, label: string) => TransformSpec,
  label: string,
): GateTransforms {
  const out: GateTransforms = {};
  for (const axis of axes) {
    out[axis.channel] = axis.transform === null ? { kind: "identity" } : readSpec(axis.transform, `transform of ${axis.channel} on ${label}`);
  }
  return out;
}

function readAxes(value: unknown, label: string, readSpec: (value: unknown, label: string) => TransformSpec): HostedHierarchyAxis[] {
  const axes = list(value, `axes of ${label}`).map((axis) => {
    const source = record(axis, `axis of ${label}`);
    const transform = source.transform === null || source.transform === undefined
      ? null
      : readSpec(source.transform, `transform of ${label}`);
    return { channel: text(source.channel, `axis channel of ${label}`), transform };
  });
  if (axes.length < 1 || axes.length > 2) throw new Error(`The GatingSet hierarchy has a malformed ${label}: ${axes.length} axes.`);
  return axes;
}

/** A quadrant set's members: the populations it makes, numbered as the app numbers quadrants. */
type QuadrantMembers = readonly Readonly<{ path: string; name: string; quadrant: number }>[];

/** A node's gate as a GateLab gate, or the reason the translation cannot hold it. */
type BuiltGate = { gate: Gate; members?: QuadrantMembers } | { drop: string };

/**
 * One node's gate in GateLab's form, under `gateId`: a rectangle, polygon or ellipse, or a
 * quadrant set's one gate with its members. A malformed gate throws; one the dataset cannot hold
 * (a channel it lacks, a polygon of fewer than three vertices) is dropped with the reason.
 */
function buildGate(
  raw: unknown,
  gateId: string,
  common: Readonly<{ name: string; color: string }>,
  label: string,
  channelIds: ReadonlySet<string>,
  readSpec: (value: unknown, label: string) => TransformSpec,
): BuiltGate {
  const gate = record(raw, `gate of ${label}`);
  const kind = gate.kind;
  const axes = readAxes(gate.axes, label, readSpec);
  const unknown = axes.find((axis) => !channelIds.has(axis.channel));
  if (unknown) return { drop: `on channel '${unknown.channel}', which the dataset does not have` };
  const transforms = gateTransforms(axes, readSpec, label);
  const base = {
    gate_id: gateId,
    name: common.name,
    x_channel: axes[0].channel,
    y_channel: (axes[1] ?? axes[0]).channel,
    space: "display" as const,
    transforms,
    color: common.color,
    label_offset: null,
  };

  if (kind === "rectangle") {
    // A one-axis gate's single null bound unboxes to null in R's JSON, which is no bound.
    const bounds = (value: unknown, side: string): unknown[] =>
      (value === null || value === undefined) && axes.length === 1 ? [null] : list(value, `${side} of ${label}`);
    const min = bounds(gate.min, "min");
    const max = bounds(gate.max, "max");
    if (min.length !== axes.length || max.length !== axes.length) {
      throw new Error(`The GatingSet hierarchy has a malformed ${label}: bounds and axes differ.`);
    }
    // A range gate repeats its channel on both axes with no bound on the second, as the
    // Gating-ML importer does, which keeps the interval exactly.
    const xlo = bound(min[0], `min of ${label}`);
    const xhi = bound(max[0], `max of ${label}`);
    const ylo = axes.length === 2 ? bound(min[1], `min of ${label}`) : null;
    const yhi = axes.length === 2 ? bound(max[1], `max of ${label}`) : null;
    return {
      gate: {
        ...base,
        gate_type: "rectangle",
        vertices: rectangleVertices(xlo, xhi, ylo, yhi),
        // flowCore's rectangleGate holds an event on either edge (models.ts, RectangleBounds).
        bounds: "closed",
      },
    };
  }
  if (kind === "polygon") {
    if (axes.length !== 2) throw new Error(`The GatingSet hierarchy has a malformed ${label}: a polygon needs two axes.`);
    const vertices = list(gate.vertices, `vertices of ${label}`).map((vertex, index): Vertex => {
      if (!Array.isArray(vertex) || vertex.length !== 2) throw new Error(`The GatingSet hierarchy has a malformed vertex ${index + 1} of ${label}.`);
      return [finite(vertex[0], `vertex ${index + 1} of ${label}`), finite(vertex[1], `vertex ${index + 1} of ${label}`)];
    });
    if (vertices.length < 3) return { drop: `a polygon of ${vertices.length} vertices` };
    return { gate: { ...base, gate_type: "polygon", vertices } };
  }
  if (kind === "ellipse") {
    if (axes.length !== 2) throw new Error(`The GatingSet hierarchy has a malformed ${label}: an ellipse needs two axes.`);
    const mean = list(gate.mean, `mean of ${label}`);
    const covariance = list(gate.covariance, `covariance of ${label}`);
    if (mean.length !== 2 || covariance.length !== 2) throw new Error(`The GatingSet hierarchy has a malformed ${label}: mean or covariance.`);
    const rows = covariance.map((row, index) => {
      const entries = list(row, `covariance row ${index + 1} of ${label}`);
      if (entries.length !== 2) throw new Error(`The GatingSet hierarchy has a malformed covariance row ${index + 1} of ${label}.`);
      return [finite(entries[0], `covariance of ${label}`), finite(entries[1], `covariance of ${label}`)] as [number, number];
    });
    const distance = finite(gate.distance, `distance of ${label}`);
    if (!(distance > 0)) throw new Error(`The GatingSet hierarchy has a malformed ${label}: distance ${distance}.`);
    return {
      gate: {
        ...base,
        gate_type: "ellipse",
        mean: [finite(mean[0], `mean of ${label}`), finite(mean[1], `mean of ${label}`)],
        covariance: [rows[0], rows[1]],
        // flowCore tests the Mahalanobis distance against `distance`; the app holds its square.
        distance_square: distance * distance,
      },
    };
  }
  if (kind === "quadrant") {
    if (axes.length !== 2) throw new Error(`The GatingSet hierarchy has a malformed ${label}: a quadrant set needs two axes.`);
    const center = list(gate.center, `centre of ${label}`);
    if (center.length !== 2) throw new Error(`The GatingSet hierarchy has a malformed ${label}: centre.`);
    const members = list(gate.members, `members of ${label}`).map((member) => {
      const item = record(member, `member of ${label}`);
      const quadrant = finite(item.quadrant, `quadrant number of ${label}`);
      if (![1, 2, 3, 4].includes(quadrant)) throw new Error(`The GatingSet hierarchy has a malformed ${label}: quadrant ${quadrant}.`);
      return { path: text(item.path, `member path of ${label}`), name: text(item.name, `member name of ${label}`), quadrant };
    });
    if (members.length === 0) throw new Error(`The GatingSet hierarchy has a malformed ${label}: no members.`);
    return {
      gate: {
        ...base,
        gate_type: "quadrant",
        center: [finite(center[0], `centre of ${label}`), finite(center[1], `centre of ${label}`)],
      },
      members,
    };
  }
  throw new Error(`The GatingSet hierarchy has a malformed ${label}: gate kind '${String(kind)}'.`);
}

/** Whether two quadrant sets have the same members in the same quadrants. */
function sameMembers(a: QuadrantMembers | undefined, b: QuadrantMembers | undefined): boolean {
  const key = (members: QuadrantMembers | undefined) =>
    JSON.stringify([...(members ?? [])].map((m) => [m.path, m.quadrant]).sort());
  return key(a) === key(b);
}

/**
 * The hierarchy as GateLab gates and populations: one population per node under the root, one
 * gate per geometric node (a quadrant set is one gate with four populations), a negated node
 * excluding its gate, a boolean node referencing the gates of the nodes it names. Nodes the
 * translation cannot hold are left out with the reason, and so are their descendants, since a
 * population needs its parent. A sample whose gate differs on some node gets a tailored copy of
 * the tree, owned by that sample, carrying its own gates.
 */
export function translateGatingSetHierarchy(
  raw: unknown,
  dataset: GateLabHostDatasetDescriptor,
  readSpec: (value: unknown, label: string) => TransformSpec,
): HostedHierarchyTranslation {
  const source = record(raw, "payload");
  if (typeof source.contractVersion !== "number" || !READABLE_CONTRACTS.includes(source.contractVersion)) {
    throw new Error(`The GatingSet hierarchy uses contract ${String(source.contractVersion)}; this GateLab reads ${READABLE_CONTRACTS.join(" and ")}.`);
  }
  const channelIds = new Set(dataset.channels.map((channel) => channel.id));
  const sampleIds = new Set(dataset.samples.map((sample) => sample.id));
  const nodes = list(source.nodes, "node list").map((node) => record(node, "node"));
  const leftOut: string[] = [];
  const dropped = new Set<string>();
  for (const entry of list(source.leftOut, "left-out list")) {
    const item = record(entry, "left-out entry");
    const path = text(item.path, "left-out path");
    // A node under one the host left out is left out with it, and says so.
    dropped.add(path);
    leftOut.push(`${path}: ${text(item.reason, "left-out reason")}`);
  }

  const gates: Record<string, Gate> = {};
  const gateOrder: string[] = [];
  const populations: PopulationMap = {
    [ROOT_POPULATION_ID]: {
      population_id: ROOT_POPULATION_ID,
      name: "All Events",
      gate_refs: [],
      gate_logic: "and",
      parent_id: null,
      children: [],
      event_count: null,
      percent_of_parent: null,
    },
  };
  /** What a node's population tests, for a boolean that names it: its gate and side. */
  const nodeRef = new Map<string, GateRef>();
  /** Each sample's own gates, by the tree's gate id, where they differ from the tree's. */
  const tailored = new Map<string, Map<string, Gate>>();

  const drop = (path: string, reason: string): void => {
    dropped.add(path);
    leftOut.push(`${path}: ${reason}`);
  };
  const addGate = (gate: Gate): void => {
    gates[gate.gate_id] = gate;
    gateOrder.push(gate.gate_id);
  };
  const addPopulation = (path: string, name: string, parent: string, refs: GateRef[], logic: "and" | "or" = "and"): void => {
    populations[path] = {
      population_id: path,
      name,
      gate_refs: refs,
      gate_logic: logic,
      parent_id: parent,
      children: [],
      event_count: null,
      percent_of_parent: null,
    };
    populations[parent].children.push(path);
  };

  // Nodes arrive in the object's order, parents before children (gs_get_pop_paths), and a
  // boolean names nodes that come before it.
  for (const node of nodes) {
    const path = text(node.path, "node path");
    const name = typeof node.name === "string" && node.name ? node.name : path.slice(path.lastIndexOf("/") + 1);
    const parentPath = typeof node.parent === "string" && node.parent && node.parent !== "root" ? node.parent : ROOT_POPULATION_ID;
    const label = `node '${path}'`;
    if (parentPath !== ROOT_POPULATION_ID && !populations[parentPath]) {
      drop(path, dropped.has(parentPath) ? `under '${parentPath}', which was left out` : `its parent '${parentPath}' is not in the hierarchy`);
      continue;
    }
    const negated = node.negated === true;

    if (node.boolean !== undefined) {
      const spec = record(node.boolean, `boolean of ${label}`);
      const operator = spec.operator;
      if (operator !== "and" && operator !== "or") throw new Error(`The GatingSet hierarchy has a malformed boolean on ${label}.`);
      if (operator === "or") {
        // As the Gating-ML importer does: an OR population is not held (David, 2026-09-10).
        drop(path, "an OR of other nodes, which GateLab does not hold");
        continue;
      }
      const refs: GateRef[] = [];
      let unresolved: string | null = null;
      for (const entry of list(spec.refs, `references of ${label}`)) {
        const ref = record(entry, `reference of ${label}`);
        const target = text(ref.path, `reference path of ${label}`);
        const include = ref.include !== false;
        const resolved = nodeRef.get(target);
        if (!resolved) {
          unresolved = dropped.has(target) ? `names '${target}', which was left out` : `names '${target}', which has no gate of its own`;
          break;
        }
        refs.push({ ...resolved, include: include === resolved.include });
      }
      if (unresolved) {
        drop(path, unresolved);
        continue;
      }
      if (refs.length === 0) {
        drop(path, "a boolean that names no node");
        continue;
      }
      // NOT (A AND B) is NOT A OR NOT B. A population ANDs its references, so negating each one
      // would hold NOT A AND NOT B, which is fewer events; such a node is not held.
      if (negated && refs.length > 1) {
        drop(path, "a NOT of an AND of several nodes, which a GateLab population cannot hold");
        continue;
      }
      addPopulation(path, name, parentPath, negated ? refs.map((ref) => ({ ...ref, include: !ref.include })) : refs);
      continue;
    }

    if (node.gate === undefined) {
      drop(path, "neither a gate nor a boolean");
      continue;
    }
    const common = { name, color: nextGateColor(gateOrder.length) };
    const built = buildGate(node.gate, path, common, label, channelIds, readSpec);
    const members = "members" in built ? built.members : undefined;
    const dropAll = (reason: string): void => {
      if (members) for (const member of members) drop(member.path, reason);
      else drop(path, reason);
    };
    if ("drop" in built) {
      if (record(node.gate, `gate of ${label}`).kind === "quadrant") {
        // Its members are the populations; each is left out.
        const raw = list(record(node.gate, `gate of ${label}`).members, `members of ${label}`);
        for (const member of raw) drop(text(record(member, `member of ${label}`).path, `member path of ${label}`), built.drop);
      } else {
        drop(path, built.drop);
      }
      continue;
    }
    // Each sample's own gate, where it differs from the tree's.
    const own = new Map<string, Gate>();
    let refused: string | null = null;
    for (const entry of list(node.tailored, `tailoring of ${label}`)) {
      const item = record(entry, `tailoring of ${label}`);
      const sample = text(item.sample, `tailored sample of ${label}`);
      if (!sampleIds.has(sample)) throw new Error(`The GatingSet hierarchy has a malformed ${label}: it tailors sample '${sample}', which the dataset does not have.`);
      if (own.has(sample)) throw new Error(`The GatingSet hierarchy has a malformed ${label}: sample '${sample}' is tailored twice.`);
      const theirs = buildGate(item.gate, path, common, `${label} on sample '${sample}'`, channelIds, readSpec);
      if ("drop" in theirs) {
        refused = `${theirs.drop} (on sample '${sample}')`;
        break;
      }
      // A quadrant's populations name its quadrants, so a quadrant set is tailored only as the
      // same set: the same members in the same quadrants, elsewhere.
      if ((theirs.gate.gate_type === "quadrant") !== (built.gate.gate_type === "quadrant") ||
          (members !== undefined && !sameMembers(members, "members" in theirs ? theirs.members : undefined))) {
        refused = `a quadrant set on some samples and not on sample '${sample}'`;
        break;
      }
      own.set(sample, theirs.gate);
    }
    if (refused) {
      dropAll(refused);
      continue;
    }
    addGate(built.gate);
    for (const [sample, gate] of own) {
      const byGate = tailored.get(sample) ?? new Map<string, Gate>();
      byGate.set(path, gate);
      tailored.set(sample, byGate);
    }
    if (members) {
      // Each member is its own population under the parent; the quadrant node itself is none.
      // An event exactly on a divider is on its upper side here and in no quadrant in cytolib,
      // the one rule the two engines do not share.
      for (const member of members) {
        const ref: GateRef = { gate_id: path, include: true, quadrant: member.quadrant };
        nodeRef.set(member.path, ref);
        addPopulation(member.path, member.name, parentPath, [ref]);
      }
      continue;
    }
    const ref: GateRef = { gate_id: path, include: !negated };
    nodeRef.set(path, ref);
    addPopulation(path, name, parentPath, [ref]);
  }

  // A tailored copy of the tree per sample with gates of its own (tailoredImport.ts): the tree's
  // populations and gates under ids of the sample's, with provenance back to the tree's, and the
  // sample's own geometry on its tailored gates, which keep the tree's name and colour.
  const refs: HierarchyRef[] = [{ id: DEFAULT_HIERARCHY_ID, name: DEFAULT_HIERARCHY_NAME }];
  const copies: WorkspaceStoredHierarchy[] = [];
  const assignments = new Map<string, string>();
  const tailoring: { sample: string; gates: number }[] = [];
  for (const sample of dataset.samples) {
    const own = tailored.get(sample.id);
    if (!own?.size) continue;
    const prefix = `${sample.id}:`;
    const copyGates: Record<string, Gate> = {};
    const sourceGates: Record<string, string> = {};
    for (const gateId of gateOrder) {
      const tree = gates[gateId];
      const theirs = own.get(gateId);
      copyGates[prefix + gateId] = { ...structuredClone(theirs ?? tree), gate_id: prefix + gateId, name: tree.name, color: tree.color };
      sourceGates[prefix + gateId] = gateId;
    }
    const copyPopulations: PopulationMap = {};
    const sourcePopulations: Record<string, string> = {};
    for (const [id, population] of Object.entries(populations)) {
      copyPopulations[prefix + id] = {
        ...structuredClone(population),
        population_id: prefix + id,
        parent_id: population.parent_id === null ? null : prefix + population.parent_id,
        children: population.children.map((child) => prefix + child),
        gate_refs: population.gate_refs.map((ref) => ({ ...ref, gate_id: prefix + ref.gate_id })),
      };
      sourcePopulations[prefix + id] = id;
    }
    const ref: HierarchyRef = {
      id: tailoredHierarchyId(sample.id),
      name: uniqueHierarchyName(`${sample.label || sample.id} · ${DEFAULT_HIERARCHY_NAME}`, refs),
      owner_sample_id: `${dataset.id}:${sample.id}`,
      structure_locked: true,
      source_hierarchy_id: DEFAULT_HIERARCHY_ID,
      source_gate_ids: sourceGates,
      source_population_ids: sourcePopulations,
    };
    refs.push(ref);
    copies.push({
      ...ref,
      gates: copyGates,
      gate_order: gateOrder.map((id) => prefix + id),
      populations: copyPopulations,
      root_population_id: prefix + ROOT_POPULATION_ID,
      active_population_id: prefix + ROOT_POPULATION_ID,
    });
    assignments.set(sample.id, ref.id);
    tailoring.push({ sample: sample.label || sample.id, gates: own.size });
  }

  // Open on the scatter pair, as a file opens, rather than on whichever channel the object
  // lists first (CytoML's FlowJo parse lists Time first).
  const scatter = dataset.channels.filter((channel) => /^(FSC|SSC)/i.test(channel.pnn ?? channel.id));
  const firstX = scatter[0]?.id ?? dataset.channels[0]?.id ?? "";
  const firstY = scatter[1]?.id ?? dataset.channels.find((channel) => channel.id !== firstX)?.id ?? firstX;
  const workspace: WorkspaceFile = {
    format: WORKSPACE_FORMAT,
    version: 2,
    workspaceId: `gatingset:${dataset.id}`,
    savedAt: new Date(0).toISOString(),
    app: "GateLabR",
    samples: dataset.samples.map((sample, index) => ({
      sampleId: `${dataset.id}:${sample.id}`,
      fileName: sample.label || `Sample ${index + 1}`,
      dataPath: `data/sce-${index + 1}.fcs`,
      logicleW: {},
      compensationOn: false,
      ...(dataset.instrument === "flow" || dataset.instrument === "cytof"
        ? { instrumentMode: dataset.instrument }
        : {}),
      ...(assignments.has(sample.id) ? { hierarchyId: assignments.get(sample.id) } : {}),
    })),
    activeSample: 0,
    gating: {
      gates,
      gate_order: gateOrder,
      populations,
      root_population_id: ROOT_POPULATION_ID,
      active_population_id: ROOT_POPULATION_ID,
      selected_gate_id: null,
      // Only where a sample is tailored: an object with one gate per node opens as before.
      ...(copies.length
        ? {
            hierarchies: refs,
            active_hierarchy_id: DEFAULT_HIERARCHY_ID,
            stored_hierarchies: copies,
            perFileHierarchies: true,
            perFileHierarchyCopiesInitialized: true,
          }
        : {}),
    },
    scales: { globalScales: {} },
    display: {
      xChannel: firstX,
      yChannel: firstY,
      mode: "pseudocolor",
      maxEvents: 50000,
      contourThreshold: 5,
    },
  };
  validateWorkspace(workspace);
  return { workspace, leftOut, tailoring };
}

/** The populations of a translated hierarchy, for the status line. */
export function translatedCounts(translation: HostedHierarchyTranslation): { gates: number; populations: number } {
  return {
    gates: translation.workspace.gating.gate_order.length,
    populations: Object.keys(translation.workspace.gating.populations).length - 1,
  };
}

/** True when the translation holds a population, so there is something to show. */
export function translationIsEmpty(translation: HostedHierarchyTranslation): boolean {
  return Object.keys(translation.workspace.gating.populations).length <= 1;
}

export type { Population };
