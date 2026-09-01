// models.ts — Gate, population, and gate-reference data structures.
// Ported 1:1 from GateLabR inst/app/R/models.R (constructors + tree operations).
// R named-lists of populations become a Record<string, Population> keyed by id.

export type Vertex = [number, number];

/**
 * The coordinate space a gate's vertices live in, and in which its edges are straight.
 *
 * `raw`     — straight in raw channel values. Membership cannot change when a display control
 *             moves, and the boundary bows when drawn on a transformed axis.
 * `display` — straight in the transformed space recorded in `transforms`, which is Gating-ML's
 *             model (the transform belongs to the gate, via `transformation-ref`). Membership is
 *             still fixed, because the gate carries its own transform rather than reading the
 *             current one — that is the difference from FlowJo, whose gates move with the view.
 *
 * Absent means "whatever this sample did before the field existed": raw for flow, display for
 * CyTOF. Never default it to a literal, or every saved CyTOF workspace changes meaning.
 * See `LabNotes/Coding/GateLab/GateLab — gating space (raw vs display) design.md`.
 */
export type GateSpace = "raw" | "display";

/**
 * A display transform, in a form that can be serialised and rebuilt exactly.
 *
 * `biex` and `wsplog` are FlowJo's own display transforms. GateLab never *displays* on them —
 * they arrive only on gates imported from a .wsp, where they record the space FlowJo evaluates
 * the gate in. That separation is why they cost nothing in the UI: a gate can live in biex space,
 * evaluate exactly, and still be drawn on GateLab's own axis, where it bows to show honestly that
 * it was drawn under a different transform.
 */
export type TransformSpec =
  | { kind: "identity" }
  | { kind: "asinh"; cofactor: number }
  | { kind: "logicle"; T: number; W: number; M: number; A: number }
  | { kind: "biex"; maxValue: number; pos: number; neg: number; widthBasis: number; channelRange: number }
  | { kind: "wsplog"; offset: number; decades: number };

/** The transform each axis was drawn under. Only meaningful when `space` is `display`. */
export type GateTransforms = Record<string, TransformSpec>;

export interface PolyRectGate {
  gate_id: string;
  name: string;
  gate_type: "polygon" | "rectangle";
  x_channel: string;
  y_channel: string;
  vertices: Vertex[];
  /** Space the vertices are straight in; absent = this sample's pre-field default. */
  space?: GateSpace;
  /** Per-axis transform the gate was drawn under. Present only when space is display. */
  transforms?: GateTransforms;
  color: string;
  label_offset: [number, number] | null;
}

export interface QuadrantGate {
  gate_id: string;
  name: string;
  gate_type: "quadrant";
  x_channel: string;
  y_channel: string;
  center: [number, number];
  /** Space the vertices are straight in; absent = this sample's pre-field default. */
  space?: GateSpace;
  /** Per-axis transform the gate was drawn under. Present only when space is display. */
  transforms?: GateTransforms;
  color: string;
  label_offset: [number, number] | null;
}

/**
 * An ellipse held in its Gating-ML form: centre, covariance and a squared Mahalanobis radius.
 *
 * The covariance form is the interchange representation (Gating-ML EllipsoidGate; Cytobank and
 * FlowJo both write it) and doubles as the evaluation form — membership is one quadratic-form
 * test, with no axis/angle decomposition anywhere it could drift. Like every other gate, the
 * parameters live in the gate's own space: raw, or display with the transforms recorded, and
 * evaluation transforms events into that space first. That matches how FlowJo evaluates an
 * ellipse drawn on biex axes — as a true ellipse in DISPLAY coordinates, which is not an
 * ellipse in raw space at all.
 */
export interface EllipseGate {
  gate_id: string;
  name: string;
  gate_type: "ellipse";
  x_channel: string;
  y_channel: string;
  /** Centre (the Gating-ML mean), in the gate's space. */
  mean: [number, number];
  /** Symmetric 2×2 covariance, row-major, in the gate's space. */
  covariance: [[number, number], [number, number]];
  /** Squared Mahalanobis distance of the boundary (Gating-ML distanceSquare). */
  distance_square: number;
  /** Space the parameters live in; absent = this sample's pre-field default. */
  space?: GateSpace;
  /** Per-axis transform the gate was drawn under. Present only when space is display. */
  transforms?: GateTransforms;
  color: string;
  label_offset: [number, number] | null;
}

export type Gate = PolyRectGate | QuadrantGate | EllipseGate;

export interface GateRef {
  gate_id: string;
  include: boolean;
  /** For quadrant gates, which quadrant (1-4) this ref selects. */
  quadrant?: number;
}

export interface Population {
  population_id: string;
  name: string;
  gate_refs: GateRef[];
  gate_logic: "and" | "or";
  parent_id: string | null;
  children: string[];
  event_count: number | null;
  percent_of_parent: number | null;
  // Stable colour slot: assigned once at creation (lowest free integer) and never changed, so a
  // population keeps its colour when others are added/removed. Read via populationColor(palette,
  // colorSlot); the root/ungated has none. Optional for backward-compat — ensurePopColorSlots()
  // backfills populations loaded from a pre-colorSlot workspace. See [[freeze-colours]].
  colorSlot?: number;
}

export type PopulationMap = Record<string, Population>;

export const GATE_COLORS = [
  "#e41a1c", "#377eb8", "#4daf4a", "#984ea3", "#ff7f00",
  "#a65628", "#f781bf", "#999999", "#e6ab02", "#66c2a5",
];

/** Next gate colour from the palette (cycles). */
export function nextGateColor(nExisting: number): string {
  return GATE_COLORS[nExisting % GATE_COLORS.length];
}

function uuid(): string {
  return crypto.randomUUID();
}

export function newGate(
  name: string,
  gateType: "polygon" | "rectangle",
  xChannel: string,
  yChannel: string,
  vertices: Vertex[],
  color?: string,
  labelOffset: [number, number] | null = null,
): PolyRectGate {
  return {
    gate_id: uuid(),
    name,
    gate_type: gateType,
    x_channel: xChannel,
    y_channel: yChannel,
    vertices,
    color: color ?? GATE_COLORS[0],
    label_offset: labelOffset,
  };
}

export function newQuadrantGate(
  name: string,
  xChannel: string,
  yChannel: string,
  center: [number, number],
  color?: string,
  labelOffset: [number, number] | null = null,
): QuadrantGate {
  return {
    gate_id: uuid(),
    name,
    gate_type: "quadrant",
    x_channel: xChannel,
    y_channel: yChannel,
    center,
    color: color ?? GATE_COLORS[0],
    label_offset: labelOffset,
  };
}

export function newGateRef(gateId: string, include = true, quadrant?: number): GateRef {
  const ref: GateRef = { gate_id: gateId, include };
  if (quadrant !== undefined && quadrant !== null) ref.quadrant = Math.trunc(quadrant);
  return ref;
}

export function newPopulation(
  name: string,
  gateRefs: GateRef[] = [],
  parentId: string | null = null,
  gateLogic: "and" | "or" = "and",
): Population {
  return {
    population_id: uuid(),
    name,
    gate_refs: gateRefs,
    gate_logic: gateLogic,
    parent_id: parentId,
    children: [],
    event_count: null,
    percent_of_parent: null,
  };
}

export function newRootPopulation(eventCount: number | null = null): Population {
  const pop = newPopulation("All Events");
  pop.event_count = eventCount;
  pop.percent_of_parent = 100.0;
  return pop;
}

export function validateGate(gate: Gate): true {
  if (!gate.gate_id) throw new Error("Gate must have a gate_id");
  if (!gate.name) throw new Error("Gate must have a name");
  if (!["polygon", "rectangle", "quadrant", "ellipse"].includes(gate.gate_type)) {
    throw new Error(`Gate type must be 'polygon', 'rectangle', 'quadrant' or 'ellipse', got: ${gate.gate_type}`);
  }
  if (gate.gate_type === "polygon" && (gate as PolyRectGate).vertices.length < 3) {
    throw new Error("Polygon gate must have at least 3 vertices");
  }
  if (gate.gate_type === "rectangle" && (gate as PolyRectGate).vertices.length < 2) {
    throw new Error("Rectangle gate must have at least 2 vertices (corners)");
  }
  if (gate.gate_type === "quadrant" && (gate as QuadrantGate).center.length !== 2) {
    throw new Error("Quadrant gate must have a center of length 2");
  }
  return true;
}

/** Add a child population to a parent (idempotent on children). */
export function linkChildToParent(
  populations: PopulationMap,
  childId: string,
  parentId: string,
): PopulationMap {
  const parent = populations[parentId];
  if (parent && !parent.children.includes(childId)) parent.children.push(childId);
  if (populations[childId]) populations[childId].parent_id = parentId;
  return populations;
}

/**
 * Normalise every reachable children list without changing its stored order.
 *
 * The historical name is retained for compatibility with existing callers. Population
 * order is now user-controlled, so this function only removes duplicates, missing ids,
 * and self-links while walking the tree.
 */
export function sortPopulationTree(
  populations: PopulationMap,
  rootPopulationId: string,
): PopulationMap {
  if (!rootPopulationId || !populations[rootPopulationId]) return populations;

  const recurse = (popId: string): void => {
    const pop = populations[popId];
    if (!pop) return;
    const childIds = [...new Set(pop.children)].filter(
      (cid) => cid in populations && cid !== popId,
    );
    pop.children = childIds;
    for (const cid of childIds) recurse(cid);
  };

  recurse(rootPopulationId);
  return populations;
}

/** Explicitly alphabetise every sibling group while preserving the hierarchy. */
export function sortPopulationTreeAlpha(
  populations: PopulationMap,
  rootPopulationId: string,
): PopulationMap {
  sortPopulationTree(populations, rootPopulationId);
  if (!rootPopulationId || !populations[rootPopulationId]) return populations;

  const visited = new Set<string>();
  const recurse = (popId: string): void => {
    if (visited.has(popId)) return;
    visited.add(popId);
    const pop = populations[popId];
    if (!pop) return;
    pop.children.sort((leftId, rightId) => {
      const left = (populations[leftId]?.name || leftId).toLocaleLowerCase();
      const right = (populations[rightId]?.name || rightId).toLocaleLowerCase();
      return left < right
        ? -1
        : left > right
          ? 1
          : leftId < rightId
            ? -1
            : leftId > rightId
              ? 1
              : 0;
    });
    for (const childId of pop.children) recurse(childId);
  };
  recurse(rootPopulationId);
  return populations;
}

/** Remove a population and its entire subtree. */
export function removePopulationSubtree(populations: PopulationMap, popId: string): PopulationMap {
  const toRemove: string[] = [];
  const queue = [popId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    toRemove.push(current);
    const pop = populations[current];
    if (pop && pop.children.length > 0) queue.push(...pop.children);
  }
  const parentId = populations[popId]?.parent_id;
  if (parentId && populations[parentId]) {
    populations[parentId].children = populations[parentId].children.filter((c) => c !== popId);
  }
  for (const rid of toRemove) delete populations[rid];
  return populations;
}

/** Remove one population, reparenting its direct children to its parent. */
export function removePopulationReparentChildren(
  populations: PopulationMap,
  popId: string,
): PopulationMap {
  const pop = populations[popId];
  if (!pop) return populations;
  const parentId = pop.parent_id;
  const childIds = [...new Set(pop.children)].filter((c) => c in populations && c !== popId);

  if (parentId && populations[parentId]) {
    const p = populations[parentId];
    p.children = p.children.filter((c) => c !== popId);
    p.children = [...new Set([...p.children, ...childIds])];
    for (const cid of childIds) if (populations[cid]) populations[cid].parent_id = parentId;
  } else {
    for (const cid of childIds) if (populations[cid]) populations[cid].parent_id = null;
  }
  delete populations[popId];
  return populations;
}

/** Would reparenting popId under newParentId create a cycle? */
export function wouldCreateCycle(
  populations: PopulationMap,
  popId: string,
  newParentId: string | null,
): boolean {
  let current: string | null = newParentId;
  while (current) {
    if (current === popId) return true;
    current = populations[current]?.parent_id ?? null;
  }
  return false;
}
