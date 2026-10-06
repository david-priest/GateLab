// models.ts — Gate, population, and gate-reference data structures.
// Ported 1:1 from GateLabR inst/app/R/models.R (constructors + tree operations).
// R named-lists of populations become a Record<string, Population> keyed by id.

export type Vertex = [number, number];

/**
 * A rectangle edge with no bound, as a coordinate: the largest finite double, so every event is
 * within it in any space, and it survives a workspace save, which JSON cannot do for Infinity.
 * Gating-ML import holds an absent gating:min or gating:max as −UNBOUNDED or +UNBOUNDED, and the
 * exporters write such an edge unbounded again. It was ±1e9 until 2026-09, which is below real
 * raw values (the public S8 file reaches 2.15e9), so an open range there left events out.
 */
export const UNBOUNDED = Number.MAX_VALUE;

/** True for a coordinate at or beyond ±UNBOUNDED (Infinity too): an edge with no bound. */
export const isUnbounded = (v: number): boolean => Math.abs(v) >= UNBOUNDED;

/**
 * Where an unbounded edge is drawn, as a raw value: past every event (the S8 file's largest is
 * 2.15e9) and still a finite coordinate on a linear axis, where UNBOUNDED itself is not one.
 */
export const UNBOUNDED_DRAWN_AT = 1e12;

/** A raw value to draw at: itself, or ±UNBOUNDED_DRAWN_AT for an edge with no bound. */
export const drawnRaw = (v: number): number => (isUnbounded(v) ? Math.sign(v) * UNBOUNDED_DRAWN_AT : v);

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
 * `flog` is Gating-ML's logarithmic scale, carried for the same reason: a gate imported from a
 * Gating-ML document declares the space its vertices are straight in, and §4.2.3 makes that space
 * part of the gate. Holding it is what lets a log polygon come back the shape it left as.
 *
 * `biex` and `wsplog` are FlowJo's own display transforms. GateLab never *displays* on them —
 * they arrive only on gates imported from a .wsp, where they record the space FlowJo evaluates
 * the gate in. That separation is why they cost nothing in the UI: a gate can live in biex space,
 * evaluate exactly, and still be drawn on GateLab's own axis, where it bows to show honestly that
 * it was drawn under a different transform. A `biex` spec's `tableChannels` says which table it
 * is evaluated on: 4096 for FlowJo's own, absent for the one GateLab built before 2026-09-24,
 * which a gate saved then keeps (biex.ts).
 *
 * `flowjoChannels` is FlowJo's gate grid (flowjoGrid.ts): the axis quantised to `channels`
 * integer channels by FlowJo's rule for its `axis`, events clamped to the grid, vertices on it. It
 * arrives only on polygons imported from a .wsp with "Evaluate gates as FlowJo does" on, and
 * only on both axes of a gate at once. Editing such a gate keeps its vertices on channels; no
 * gate is ever drawn on it.
 *
 * `bounds` is a Gating-ML 2.0 transformation's boundMin and boundMax, in the spec's own output
 * units: a transformed value below `min` is taken as `min`, and one above `max` as `max`, before
 * the gate is tested (Transformations.v2.0.xsd; flowCore applies them the same way). They arrive
 * only from a Gating-ML file, and only on the kinds a Gating-ML transformation can become.
 */
export type TransformSpec =
  | { kind: "identity"; bounds?: TransformBounds }
  | { kind: "asinh"; cofactor: number; bounds?: TransformBounds }
  | { kind: "logicle"; T: number; W: number; M: number; A: number; bounds?: TransformBounds }
  | {
    kind: "biex"; maxValue: number; pos: number; neg: number; widthBasis: number; channelRange: number;
    /** 4096 on FlowJo's table; absent on a spec saved before it, which keeps the old table. */
    tableChannels?: number;
  }
  | { kind: "wsplog"; offset: number; decades: number }
  | {
      kind: "flog"; T: number; M: number;
      /**
       * True for Gating-ML 2.0's flog exactly: −Infinity at x = 0 and NaN below, so an event
       * below zero is in no gate and one at zero only in a rectangle with no lower bound on that
       * axis (gateMaskRectangle), and nothing is clamped. Absent for the flog GateLab held before 2026-09,
       * which pins every x below T·10^−M at y = 0 (biex.ts flogTransform); gates in saved
       * workspaces and in GateLab's own older files keep that meaning.
       */
      standard?: boolean;
      bounds?: TransformBounds;
    }
  | { kind: "flowjoChannels"; channels: number; axis: FlowJoGridAxis };

/**
 * One axis of FlowJo's gate grid, as the sample's <Transformations> element saved it: a linear
 * axis's range, a log axis's offset and decades, or a biex axis's parameters (always evaluated on
 * FlowJo's 4096-channel table, so no `tableChannels` is carried).
 */
export type FlowJoGridAxis =
  | { kind: "linear"; minRange: number; maxRange: number }
  | { kind: "wsplog"; offset: number; decades: number }
  | { kind: "biex"; maxValue: number; pos: number; neg: number; widthBasis: number; channelRange: number };

/** A Gating-ML transformation's boundMin / boundMax, in the transformed units; either may be absent. */
export interface TransformBounds {
  min?: number;
  max?: number;
}

/** The transform each axis was drawn under. Only meaningful when `space` is `display`. */
export type GateTransforms = Record<string, TransformSpec>;

/**
 * Which of a rectangle's edges hold the events that lie exactly on them.
 *
 * `half-open` is Gating-ML 2.0's rule (section 5.1.1): on each axis min <= x < max, the lower edge
 * in and the upper edge out, "so that a set of rectangle gates that covers the data space will
 * sum properly with no missing or duplicated events". FlowKit evaluates rectangles this way. A
 * rectangle drawn in GateLab from 2026-09 on is half-open, and so is one read from a Gating-ML file
 * whose writer cannot be identified.
 *
 * `closed` is min <= x <= max, the rule every GateLab rectangle followed before 2026-09. It is
 * what a rectangle keeps when it was evaluated that way before: one saved in a workspace, a
 * Gating-ML file or a hierarchy CSV without this field, and one imported from a writer whose own
 * rule is closed (FlowJo, flowCore and flowUtils, CytoML), or whose rule has not been measured
 * (Cytobank, FACSDiva, FACSChorus), where the previous behaviour stands. `rectangleRule` reads
 * the field; the importers say which writer is which (gatingml.ts, GatingMLWriter).
 *
 * ABSENT MEANS CLOSED, and must never be defaulted to anything else: every workspace saved before
 * the field existed evaluated its rectangles closed, and absent is what keeps that meaning.
 * Everything GateLab writes from 2026-09 on states the rule explicitly.
 *
 * Polygons, ellipses and quadrants need no field: Gating-ML makes a polygon's and an ellipse's
 * boundary inclusive and puts an event on a quadrant divider on the divider's upper side, and
 * GateLab already evaluates all three that way.
 */
export type RectangleBounds = "closed" | "half-open";

/** The edge rule a rectangle is evaluated under: its own, or closed when it has none. */
export function rectangleRule(gate: { bounds?: RectangleBounds }): RectangleBounds {
  return gate.bounds === "half-open" ? "half-open" : "closed";
}

/** A value `bounds` may hold in a file: anything else is refused rather than read as a default. */
export function isRectangleBounds(value: unknown): value is RectangleBounds {
  return value === "closed" || value === "half-open";
}

/**
 * The same gates with every rectangle's edge rule stated. A rectangle with none is closed (see
 * RectangleBounds), and saying so is what lets a file written now carry its meaning explicitly.
 * Returns the input unchanged when there is nothing to state.
 */
export function withExplicitRectangleBounds<T extends Record<string, Gate>>(gates: T): T {
  let out: T | null = null;
  for (const [id, gate] of Object.entries(gates)) {
    if (gate.gate_type !== "rectangle" || gate.bounds !== undefined) continue;
    if (!out) out = { ...gates };
    (out as Record<string, Gate>)[id] = { ...gate, bounds: "closed" };
  }
  return out ?? gates;
}

/**
 * Who made a gate and why, when it was not drawn by hand: a connected agent's proposal, with the
 * reason it gave. Shown on the gate card so an agent's gates are told from the user's, and kept
 * with the gate wherever the workspace goes. Evaluation never reads it.
 */
export interface GateProvenance {
  /** The writer's name, as the agent introduced itself. */
  by: string;
  rationale: string;
  /** When it was made, ISO 8601. */
  at: string;
}

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
  /** Rectangles only: the edge rule; absent = closed, as before the field existed (RectangleBounds). */
  bounds?: RectangleBounds;
  /**
   * FlowJo grid polygons only (`flowjoChannels` on both axes): the vertices as the FlowJo
   * workspace saved them, in raw units, one per vertex. The FlowJo export writes them back, so
   * FlowJo re-rounds the very coordinates it saved; a vertex whose channel has since been edited
   * is written at its channel's centre instead (flowjoExport.ts). Evaluation never reads them.
   */
  flowjo_vertices?: Vertex[];
  /**
   * FlowJo rectangles imported under FlowJo's rule only: the axis FlowJo saved for each of the
   * rectangle's channels, which the rule compares in raw units and so no longer names. The FlowJo
   * export declares these axes again, so FlowJo pins an event below a biex table at the same
   * bottom and draws the same axes. Evaluation never reads them.
   */
  flowjo_axes?: Record<string, FlowJoGridAxis>;
  /**
   * FlowJo rectangles imported under FlowJo's rule only: for each channel on which the rule opened
   * a bound (an edge at or beyond where FlowJo pins its events), the [min, max] FlowJo saved, in
   * raw units (a Time bound in the file's ticks, not in FlowJo's Time units), null for a bound the
   * rule left as it was. The gate holds the opened bound as no bound. The FlowJo export writes
   * FlowJo's own value in its place while it is still open and reaches the edge of the axis the file
   * declares, so an import of the file reads FlowJo's rectangle again under whichever rule it is
   * asked for; where it does not reach that edge the bound goes out as no bound (flowjoExport.ts,
   * rectangleForFlowJo). That is the case for Time wherever an event lies past FlowJo's value, since
   * the declared Time axis ends at the data's last tick: read with the option off, such a file holds
   * FlowJo's count, not the source workspace's rectangle read with the option off (FR-FCM-Z2HV
   * 28,033, 1,060 events otherwise than the source read so; bde2d12). Evaluation never reads them.
   */
  flowjo_bounds?: Record<string, [number | null, number | null]>;
  /**
   * FlowJo polygons evaluated continuously only: FlowJo's own quadId and gateResolution where they
   * are not an ordinary polygon's (quadId -1, gateResolution 256), as for a quadrant panel or a
   * polygon with no gateResolution. The FlowJo export writes them back, so neither FlowJo nor an
   * import of the file puts the polygon on a grid it was not on. Evaluation never reads them.
   */
  flowjo_polygon?: { quadId: number; gateResolution: number | null };
  color: string;
  label_offset: [number, number] | null;
  /** Present on a gate an agent made (GateProvenance); absent on one drawn by hand. */
  provenance?: GateProvenance;
}

/**
 * Curved quadrant arms: FlowJo's "curly quad".
 *
 * Beyond the crosshair, the arm running to the right rises and the arm running up bends to the
 * right, each by k · d^power in the gate's own coordinates, where d is the distance along the
 * axis from the crosshair; the arms to the left of and below the crosshair stay straight. `kx`
 * bends the horizontal arm (y rises with x), `ky` the vertical one (x moves with y). FlowJo
 * curves them to follow photon-counting noise (p2 = a·p1^0.5 + b, docs.flowjo.com), computes
 * the bend itself, and writes nothing but percentX = percentY = 0 into the workspace. Against
 * FlowJo's own counts for 44 curly-quad populations in three public FlowRepository workspaces,
 * power 1.5 with k = 0.012 in FlowJo's 256-channel display space reproduces every quadrant
 * within 0.6% of its parent, most within 0.3% (scripts/curlyquad-calibrate.ts in the paper
 * repository); a straight crosshair is out by up to 23%. A quadrant gate without `curl` is a
 * plain crosshair.
 */
export interface QuadrantCurl {
  power: number;
  kx: number;
  ky: number;
}

/** FlowJo's bend, in its 256-channel display space, as fitted against its own counts. */
export const FLOWJO_CURLY_QUAD_CURL: Readonly<QuadrantCurl> = { power: 1.5, kx: 0.012, ky: 0.012 };

/**
 * FlowJo's bend carried into a display space whose axes span `spanX` and `spanY` units.
 *
 * FlowJo's k applies with both axes on 256 channels. A bend of k · d^p in those units is, on
 * axes of the given spans, kx' = k · 256^(p−1) · spanY / spanX^p and ky' = k · 256^(p−1) ·
 * spanX / spanY^p, so a quadrant drawn on GateLab's own axes starts with the same curve FlowJo
 * would give it. The handles then set it by eye.
 */
export function flowJoCurlForDisplay(spanX: number, spanY: number): QuadrantCurl {
  const { power, kx, ky } = FLOWJO_CURLY_QUAD_CURL;
  const scale = Math.pow(256, power - 1);
  const sx = spanX > 0 ? spanX : 1;
  const sy = spanY > 0 ? spanY : 1;
  return {
    power,
    kx: kx * scale * sy / Math.pow(sx, power),
    ky: ky * scale * sx / Math.pow(sy, power),
  };
}

export interface QuadrantGate {
  gate_id: string;
  name: string;
  gate_type: "quadrant";
  x_channel: string;
  y_channel: string;
  center: [number, number];
  /** Curved arms beyond the crosshair; absent means a straight crosshair. */
  curl?: QuadrantCurl;
  /** Space the vertices are straight in; absent = this sample's pre-field default. */
  space?: GateSpace;
  /** Per-axis transform the gate was drawn under. Present only when space is display. */
  transforms?: GateTransforms;
  color: string;
  label_offset: [number, number] | null;
  /** Present on a gate an agent made (GateProvenance); absent on one drawn by hand. */
  provenance?: GateProvenance;
  /**
   * Where each quadrant's label sits, Q1 to Q4, as a dragged delta in display units from the
   * screen quadrant's midpoint; null or absent means the midpoint. Cosmetic, like label_offset.
   */
  quadrant_label_offsets?: ([number, number] | null)[];
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
  /** Present on a gate an agent made (GateProvenance); absent on one drawn by hand. */
  provenance?: GateProvenance;
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
  if (gate.gate_type === "quadrant" && (gate as QuadrantGate).curl !== undefined && !validCurl((gate as QuadrantGate).curl)) {
    throw new Error("Quadrant gate curl must have a positive finite power and finite kx, ky");
  }
  return true;
}

/** A curl is usable when its power is positive and every coefficient is finite. */
export function validCurl(curl: unknown): curl is QuadrantCurl {
  if (!curl || typeof curl !== "object") return false;
  const c = curl as Record<string, unknown>;
  return typeof c.power === "number" && Number.isFinite(c.power) && c.power > 0
    && typeof c.kx === "number" && Number.isFinite(c.kx)
    && typeof c.ky === "number" && Number.isFinite(c.ky);
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
