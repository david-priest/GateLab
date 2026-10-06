// commands.ts — what a connected agent may ask the gating state to do, and the check each request
// gets before it becomes a reducer action. The vocabulary is small on purpose: an agent proposes
// gates and populations in the terms a user draws them, and everything else (undo, the view, the
// save) stays with the app. A command that fails a check is refused with a reason and changes
// nothing; one that passes is dispatched through the same reducer the user's drawing goes through,
// so an agent's gate is an ordinary gate with its provenance on it.

import type { Action, CoreState } from "../store";
import { isUnbounded, type GateProvenance, type GateSpace, type GateTransforms, type Vertex } from "../engine/models";

export const AGENT_COMMAND_VERSION = 1 as const;

/** An open edge of a range: null where the gate has no bound on that side. */
export type RangeBounds = [number | null, number | null];

export type AgentCommand =
  | {
      type: "createGate";
      shape: "rectangle" | "polygon";
      name: string;
      parentId: string;
      x: string;
      y: string;
      /** The space the vertices are straight in; "display" is the axes as drawn. */
      space: GateSpace;
      vertices: Vertex[];
    }
  | {
      /**
       * A rectangle from thresholds: a marker-positive range, a cut on one axis. A null bound is
       * the edge of the data on that side, so the gate holds every event beyond the threshold and
       * is still drawn within the chart.
       */
      type: "createRange";
      name: string;
      parentId: string;
      x: string;
      y: string;
      space: GateSpace;
      xBounds: RangeBounds;
      yBounds: RangeBounds;
    }
  | {
      type: "createQuadrant";
      /** The prefix of the four population names, when `names` is absent. */
      name: string;
      /**
       * The four names in quadrant order: Q1 = x− y+ (upper left), Q2 = x+ y+ (upper right),
       * Q3 = x+ y− (lower right), Q4 = x− y− (lower left), as the store numbers them.
       */
      names?: [string, string, string, string];
      parentId: string;
      x: string;
      y: string;
      space: GateSpace;
      center: Vertex;
    }
  | {
      /** An ellipse from its centre and the two half-axes, axis-aligned. */
      type: "createEllipse";
      name: string;
      parentId: string;
      x: string;
      y: string;
      space: GateSpace;
      center: Vertex;
      radii: [number, number];
    }
  | {
      /**
       * A population from gates already drawn, each taken or excluded: the AND of them (a NOT for
       * an excluded one), as the tree's "+" does. The gates stay where they are.
       */
      type: "definePopulation";
      name: string;
      parentId: string;
      gates: { gateId: string; include: boolean }[];
    }
  | {
      /** Move a population in the tree: onto another as its child, or beside it. */
      type: "movePopulation";
      populationId: string;
      targetId: string;
      placement: "inside" | "before" | "after";
    }
  | { type: "editGate"; gateId: string; vertices: Vertex[] }
  | { type: "moveQuadrantCenter"; gateId: string; center: Vertex }
  | { type: "renameGate"; gateId: string; name: string }
  | { type: "renamePopulation"; populationId: string; name: string }
  | { type: "deleteGate"; gateId: string }
  /** Removes the population; its children move up to its parent and its gates are kept. */
  | { type: "deletePopulation"; populationId: string }
  | { type: "undo" }
  | { type: "redo" };

export interface CommandContext {
  state: CoreState;
  /** The channel keys the loaded data has; a gate may name only these. */
  channels: ReadonlySet<string>;
  /** The transform each axis is drawn under, for a gate proposed in display space. */
  transformsFor: (x: string, y: string) => GateTransforms;
  /**
   * Where the data ends on a channel, in the given space, a little past the last event: an open
   * edge of a range is drawn there, as a hand-drawn rectangle would be, never off the chart.
   */
  dataEdge: (channel: string, space: GateSpace) => [number, number];
  /** Who is asking and why; put on every gate the command creates. */
  provenance: GateProvenance;
}

/** The refusal an agent gets back: the message says what was wrong, nothing was changed. */
export class AgentCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentCommandError";
  }
}

const refuse = (message: string): never => {
  throw new AgentCommandError(message);
};

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) refuse(`${label} must be a non-empty string.`);
  return (value as string).trim();
}

function finitePoint(value: unknown, label: string): Vertex {
  if (!Array.isArray(value) || value.length !== 2 || value.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
    refuse(`${label} must be two finite numbers.`);
  }
  const [x, y] = value as [number, number];
  return [x, y];
}

/** The vertices of a rectangle (two opposite corners) or a polygon (a simple outline). */
export function checkVertices(value: unknown, shape: "rectangle" | "polygon"): Vertex[] {
  if (!Array.isArray(value)) refuse("Vertices must be an array of [x, y] points.");
  const points = (value as unknown[]).map((point, i) => finitePoint(point, `Vertex ${i + 1}`));
  if (points.length > 128) refuse("A polygon may have at most 128 vertices.");
  if (shape === "rectangle") {
    if (points.length !== 2) refuse("A rectangle is two opposite corners.");
    if (points[0][0] === points[1][0] || points[0][1] === points[1][1]) refuse("A rectangle must have nonzero width and height.");
    return points;
  }
  if (points.length < 3) refuse("A polygon needs at least three vertices.");
  if (points.some((point) => point.some(isUnbounded))) refuse("A polygon has no open edges; use a range for those.");
  if (new Set(points.map((point) => point.join(","))).size !== points.length) refuse("A polygon must not repeat a vertex.");
  // Checked on the outline scaled to its own box, so the test does not depend on the axes' units.
  const xmin = Math.min(...points.map((p) => p[0])), ymin = Math.min(...points.map((p) => p[1]));
  const sx = Math.max(...points.map((p) => p[0])) - xmin, sy = Math.max(...points.map((p) => p[1])) - ymin;
  if (!(sx > 0 && sy > 0)) refuse("A polygon must have nonzero area.");
  const p = points.map(([x, y]) => [(x - xmin) / sx, (y - ymin) / sy] as Vertex);
  const cross = (a: Vertex, b: Vertex, c: Vertex) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < p.length; i++) {
    for (let j = i + 2; j < p.length; j++) {
      if (i === 0 && j === p.length - 1) continue;
      const a = p[i], b = p[(i + 1) % p.length], c = p[j], d = p[(j + 1) % p.length];
      const boxes =
        Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0])) <= Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0])) &&
        Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1])) <= Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1]));
      if (boxes && cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0) refuse("A polygon must not cross itself.");
    }
  }
  const area = p.reduce((sum, a, i) => sum + cross(p[0], a, p[(i + 1) % p.length]), 0);
  if (Math.abs(area) <= 1e-9) refuse("A polygon must have nonzero area.");
  return points;
}

function checkRange(value: unknown, label: string, edge: [number, number]): [number, number] {
  if (!Array.isArray(value) || value.length !== 2 || value.some((v) => v !== null && (typeof v !== "number" || !Number.isFinite(v)))) {
    refuse(`${label} must be [low, high], each a finite number or null for the edge of the data.`);
  }
  const given = value as RangeBounds;
  const low = given[0] ?? Math.min(edge[0], given[1] ?? edge[0]);
  const high = given[1] ?? Math.max(edge[1], given[0] ?? edge[1]);
  if (low >= high) refuse(`${label} must have low below high.`);
  return [low, high];
}

function checkAxes(ctx: CommandContext, x: unknown, y: unknown): { x: string; y: string } {
  const xKey = text(x, "x"), yKey = text(y, "y");
  if (xKey === yKey) refuse("x and y must be two different channels.");
  for (const key of [xKey, yKey]) if (!ctx.channels.has(key)) refuse(`Unknown channel “${key}”.`);
  return { x: xKey, y: yKey };
}

function checkSpace(value: unknown): GateSpace {
  if (value !== "raw" && value !== "display") refuse('space must be "raw" or "display".');
  return value as GateSpace;
}

function checkParent(ctx: CommandContext, parentId: unknown): string {
  const id = text(parentId, "parentId");
  if (!Object.hasOwn(ctx.state.populations, id)) refuse(`Unknown population “${id}”.`);
  return id;
}

function checkGate(ctx: CommandContext, gateId: unknown) {
  const id = text(gateId, "gateId");
  const gate = ctx.state.gates[id];
  if (!gate) refuse(`Unknown gate “${id}”.`);
  return gate;
}

/**
 * The reducer action for a command, or a refusal. The action carries the command's space and the
 * axes' transforms where it needs them, and the context's provenance on every gate it creates.
 */
export function commandToAction(command: AgentCommand, ctx: CommandContext): Action {
  if (!command || typeof command !== "object") refuse("A command is required.");
  switch (command.type) {
    case "createGate": {
      const name = text(command.name, "name");
      const parentId = checkParent(ctx, command.parentId);
      const { x, y } = checkAxes(ctx, command.x, command.y);
      const space = checkSpace(command.space);
      if (command.shape !== "rectangle" && command.shape !== "polygon") refuse('shape must be "rectangle" or "polygon".');
      const vertices = checkVertices(command.vertices, command.shape);
      return {
        type: "addGate", gateType: command.shape, name, xChannel: x, yChannel: y, vertices, space,
        transforms: space === "display" ? ctx.transformsFor(x, y) : undefined,
        createPop: { name, parentId }, provenance: ctx.provenance,
      };
    }
    case "createRange": {
      const name = text(command.name, "name");
      const parentId = checkParent(ctx, command.parentId);
      const { x, y } = checkAxes(ctx, command.x, command.y);
      const space = checkSpace(command.space);
      const given = [command.xBounds, command.yBounds] as unknown[];
      if (given.every((b) => Array.isArray(b) && b.every((v) => v === null))) refuse("A range needs at least one bound.");
      const [xlo, xhi] = checkRange(command.xBounds, "xBounds", ctx.dataEdge(x, space));
      const [ylo, yhi] = checkRange(command.yBounds, "yBounds", ctx.dataEdge(y, space));
      return {
        // Closed, so an event lying on the data's edge, where an open side was put, is inside.
        type: "addGate", gateType: "rectangle", name, xChannel: x, yChannel: y, vertices: [[xlo, ylo], [xhi, yhi]], space, bounds: "closed",
        transforms: space === "display" ? ctx.transformsFor(x, y) : undefined,
        createPop: { name, parentId }, provenance: ctx.provenance,
      };
    }
    case "createQuadrant": {
      const prefix = text(command.name, "name");
      const parentId = checkParent(ctx, command.parentId);
      const { x, y } = checkAxes(ctx, command.x, command.y);
      const space = checkSpace(command.space);
      const center = finitePoint(command.center, "center");
      let names: [string, string, string, string] | undefined;
      if (command.names !== undefined) {
        if (!Array.isArray(command.names) || command.names.length !== 4) refuse("names must be the four quadrant names, Q1 to Q4.");
        names = command.names.map((n, i) => text(n, `names[${i}]`)) as [string, string, string, string];
      }
      return {
        type: "addQuadrant", prefix, parentId, xChannel: x, yChannel: y, center, space,
        transforms: space === "display" ? ctx.transformsFor(x, y) : undefined,
        names, provenance: ctx.provenance,
      };
    }
    case "createEllipse": {
      const name = text(command.name, "name");
      const parentId = checkParent(ctx, command.parentId);
      const { x, y } = checkAxes(ctx, command.x, command.y);
      const space = checkSpace(command.space);
      const center = finitePoint(command.center, "center");
      const radii = finitePoint(command.radii, "radii");
      if (!(radii[0] > 0 && radii[1] > 0)) refuse("radii must both be positive.");
      return {
        type: "addEllipse", name, xChannel: x, yChannel: y, mean: center, radii, space,
        transforms: space === "display" ? ctx.transformsFor(x, y) : undefined,
        createPop: { name, parentId }, provenance: ctx.provenance,
      };
    }
    case "definePopulation": {
      const name = text(command.name, "name");
      const parentId = checkParent(ctx, command.parentId);
      if (!Array.isArray(command.gates) || !command.gates.length) refuse("gates must list at least one gate.");
      const gateRefs = command.gates.map((ref, i) => {
        const gate = checkGate(ctx, (ref as { gateId?: unknown })?.gateId);
        if (typeof (ref as { include?: unknown }).include !== "boolean") refuse(`gates[${i}].include must be true or false.`);
        return { gate_id: gate.gate_id, include: (ref as { include: boolean }).include };
      });
      return { type: "addPopulation", name, parentId, gateRefs };
    }
    case "movePopulation": {
      const id = text(command.populationId, "populationId");
      if (!Object.hasOwn(ctx.state.populations, id)) refuse(`Unknown population “${id}”.`);
      if (id === ctx.state.root_population_id) refuse("The root population cannot be moved.");
      const targetId = text(command.targetId, "targetId");
      if (!Object.hasOwn(ctx.state.populations, targetId)) refuse(`Unknown population “${targetId}”.`);
      if (targetId === id) refuse("A population cannot be moved onto itself.");
      if (command.placement !== "inside" && command.placement !== "before" && command.placement !== "after") refuse('placement must be "inside", "before" or "after".');
      return { type: "movePopulation", popId: id, targetId, placement: command.placement };
    }
    case "editGate": {
      const gate = checkGate(ctx, command.gateId);
      if (gate.gate_type !== "rectangle" && gate.gate_type !== "polygon") {
        return refuse(`“${gate.name}” is a ${gate.gate_type}; only a rectangle or polygon takes new vertices.`);
      }
      const vertices = checkVertices(command.vertices, gate.gate_type);
      return { type: "editGate", gateId: gate.gate_id, vertices };
    }
    case "moveQuadrantCenter": {
      const gate = checkGate(ctx, command.gateId);
      if (gate.gate_type !== "quadrant") refuse(`“${gate.name}” is not a quadrant gate.`);
      return { type: "moveQuadrantCenter", gateId: gate.gate_id, center: finitePoint(command.center, "center") };
    }
    case "renameGate": {
      const gate = checkGate(ctx, command.gateId);
      return { type: "renameGate", gateId: gate.gate_id, name: text(command.name, "name") };
    }
    case "renamePopulation": {
      const id = text(command.populationId, "populationId");
      if (!Object.hasOwn(ctx.state.populations, id)) refuse(`Unknown population “${id}”.`);
      return { type: "renamePopulation", popId: id, name: text(command.name, "name") };
    }
    case "deleteGate": {
      const gate = checkGate(ctx, command.gateId);
      return { type: "deleteGates", gateIds: [gate.gate_id] };
    }
    case "deletePopulation": {
      const id = text(command.populationId, "populationId");
      if (!Object.hasOwn(ctx.state.populations, id)) refuse(`Unknown population “${id}”.`);
      if (id === ctx.state.root_population_id) refuse("The root population cannot be deleted.");
      return { type: "deletePopulations", popIds: [id] };
    }
    case "undo":
    case "redo": {
      if (!ctx.state[command.type].length) refuse(`Nothing to ${command.type}.`);
      return { type: command.type };
    }
    default:
      return refuse(`Unsupported command “${String((command as { type?: unknown }).type)}”.`);
  }
}
