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

import type { Gate, GateRef, GateTransforms, Population, PopulationMap, TransformSpec, Vertex } from "../engine/models";
import { nextGateColor, UNBOUNDED } from "../engine/models";
import { validateWorkspace, WORKSPACE_FORMAT, type WorkspaceFile } from "../engine/workspace";
import type { GateLabHostDatasetDescriptor } from "./datasetContract";

export const GATELAB_HOST_HIERARCHY_CONTRACT_VERSION = 1 as const;

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
  /** A booleanFilter over other nodes, resolved by the host to paths. */
  boolean?: { operator: "and" | "or"; refs: readonly Readonly<{ path: string; include: boolean }>[] };
}

export interface HostedHierarchy {
  contractVersion: typeof GATELAB_HOST_HIERARCHY_CONTRACT_VERSION;
  nodes: readonly HostedHierarchyNode[];
  /** Nodes the host could not describe (a calibration-table transform, for one), with the reason. */
  leftOut?: readonly Readonly<{ path: string; reason: string }>[];
}

export interface HostedHierarchyTranslation {
  workspace: WorkspaceFile;
  /** Every node not restored, as "path: reason", for the status line. */
  leftOut: readonly string[];
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

/**
 * The hierarchy as GateLab gates and populations: one population per node under the root, one
 * gate per geometric node (a quadrant set is one gate with four populations), a negated node
 * excluding its gate, a boolean node referencing the gates of the nodes it names. Nodes the
 * translation cannot hold are left out with the reason, and so are their descendants, since a
 * population needs its parent.
 */
export function translateGatingSetHierarchy(
  raw: unknown,
  dataset: GateLabHostDatasetDescriptor,
  readSpec: (value: unknown, label: string) => TransformSpec,
): HostedHierarchyTranslation {
  const source = record(raw, "payload");
  if (source.contractVersion !== GATELAB_HOST_HIERARCHY_CONTRACT_VERSION) {
    throw new Error(`The GatingSet hierarchy uses contract ${String(source.contractVersion)}; this GateLab reads ${GATELAB_HOST_HIERARCHY_CONTRACT_VERSION}.`);
  }
  const channelIds = new Set(dataset.channels.map((channel) => channel.id));
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
      addPopulation(path, name, parentPath, negated ? refs.map((ref) => ({ ...ref, include: !ref.include })) : refs);
      continue;
    }

    if (node.gate === undefined) {
      drop(path, "neither a gate nor a boolean");
      continue;
    }
    const gate = record(node.gate, `gate of ${label}`);
    const kind = gate.kind;
    const axes = readAxes(gate.axes, label, readSpec);
    const unknown = axes.find((axis) => !channelIds.has(axis.channel));
    if (unknown) {
      drop(path, `on channel '${unknown.channel}', which the dataset does not have`);
      continue;
    }
    const transforms = gateTransforms(axes, readSpec, label);
    const xChannel = axes[0].channel;
    const yChannel = (axes[1] ?? axes[0]).channel;
    const common = {
      name,
      x_channel: xChannel,
      y_channel: yChannel,
      space: "display" as const,
      transforms,
      color: nextGateColor(gateOrder.length),
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
      addGate({
        ...common,
        gate_id: path,
        gate_type: "rectangle",
        vertices: rectangleVertices(xlo, xhi, ylo, yhi),
        // flowCore's rectangleGate holds an event on either edge (models.ts, RectangleBounds).
        bounds: "closed",
      });
    } else if (kind === "polygon") {
      if (axes.length !== 2) throw new Error(`The GatingSet hierarchy has a malformed ${label}: a polygon needs two axes.`);
      const vertices = list(gate.vertices, `vertices of ${label}`).map((vertex, index): Vertex => {
        if (!Array.isArray(vertex) || vertex.length !== 2) throw new Error(`The GatingSet hierarchy has a malformed vertex ${index + 1} of ${label}.`);
        return [finite(vertex[0], `vertex ${index + 1} of ${label}`), finite(vertex[1], `vertex ${index + 1} of ${label}`)];
      });
      if (vertices.length < 3) {
        drop(path, `a polygon of ${vertices.length} vertices`);
        continue;
      }
      addGate({ ...common, gate_id: path, gate_type: "polygon", vertices });
    } else if (kind === "ellipse") {
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
      addGate({
        ...common,
        gate_id: path,
        gate_type: "ellipse",
        mean: [finite(mean[0], `mean of ${label}`), finite(mean[1], `mean of ${label}`)],
        covariance: [rows[0], rows[1]],
        // flowCore tests the Mahalanobis distance against `distance`; the app holds its square.
        distance_square: distance * distance,
      });
    } else if (kind === "quadrant") {
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
      addGate({
        ...common,
        gate_id: path,
        gate_type: "quadrant",
        center: [finite(center[0], `centre of ${label}`), finite(center[1], `centre of ${label}`)],
      });
      // Each member is its own population under the parent; the quadrant node itself is none.
      // An event exactly on a divider is on its upper side here and in no quadrant in cytolib,
      // the one rule the two engines do not share.
      for (const member of members) {
        const ref: GateRef = { gate_id: path, include: true, quadrant: member.quadrant };
        nodeRef.set(member.path, ref);
        addPopulation(member.path, member.name, parentPath, [ref]);
      }
      continue;
    } else {
      throw new Error(`The GatingSet hierarchy has a malformed ${label}: gate kind '${String(kind)}'.`);
    }

    const ref: GateRef = { gate_id: path, include: !negated };
    nodeRef.set(path, ref);
    addPopulation(path, name, parentPath, [ref]);
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
    })),
    activeSample: 0,
    gating: {
      gates,
      gate_order: gateOrder,
      populations,
      root_population_id: ROOT_POPULATION_ID,
      active_population_id: ROOT_POPULATION_ID,
      selected_gate_id: null,
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
  return { workspace, leftOut };
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
