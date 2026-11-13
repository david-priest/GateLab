// Straight quadrant regions are open-ended, half-open rectangles. Project a temporary
// export tree so each (gate, quadrant) reference has its own primitive, including NOT refs.
// GateLab's own record of which four rectangles were one quadrant gate (GATINGML_QUADRANTS_TAG)
// rides in the document's custom_info, and GateLab's importer puts the gate back together from it
// (restoreStraightQuadrants); every other reader sees the four rectangles (David, 2026-11-10).
import { UNBOUNDED, isUnbounded, newGateRef, type Gate, type PopulationMap, type PolyRectGate } from "./models";
import { curlBends } from "./gates";

/** Gating-ML: the custom_info element naming each straight quadrant gate's four region rectangles. */
export const GATINGML_QUADRANTS_TAG = "gatelab_quadrants";

/**
 * A quadrant gate whose regions are not the four open-ended rectangles of a crosshair, which is
 * all Gating-ML can write: curled arms, or a spider quadrant, whose regions end at its box.
 */
export function isCurvedQuadrant(gate: Gate): boolean {
  return gate.gate_type === "quadrant" && (curlBends(gate.curl) || gate.arms !== undefined);
}

export function projectStraightQuadrants(
  gates: Record<string, Gate>,
  gate_order: string[],
  populations: PopulationMap,
): {
  gates: Record<string, Gate>; gate_order: string[]; populations: PopulationMap;
  /** Each straight quadrant gate's region rectangles, Q1 to Q4, by the quadrant gate's id. */
  regions: ReadonlyMap<string, readonly string[]>;
} {
  const straight = gate_order.filter((id) => gates[id]?.gate_type === "quadrant" && !isCurvedQuadrant(gates[id]));
  if (!straight.length) return { gates, gate_order, populations, regions: new Map() };
  const projected: Record<string, Gate> = { ...gates };
  const ids = new Map<string, string[]>();
  for (const id of straight) {
    const gate = gates[id];
    if (gate.gate_type !== "quadrant") continue;
    const { center: [cx, cy], curl: _curl, arms: _arms, ...base } = gate;
    const quadrants: string[] = [];
    for (let q = 1; q <= 4; q++) {
      const stem = `${id}-quadrant-${q}`;
      let rectangleId = stem;
      for (let suffix = 2; projected[rectangleId]; suffix++) rectangleId = `${stem}-${suffix}`;
      const right = q === 2 || q === 3;
      const up = q === 1 || q === 2;
      const rectangle: PolyRectGate = {
        ...base, gate_id: rectangleId, name: `${gate.name} Q${q}`, gate_type: "rectangle", bounds: "half-open",
        vertices: [[right ? cx : -UNBOUNDED, up ? cy : -UNBOUNDED], [right ? UNBOUNDED : cx, up ? UNBOUNDED : cy]],
      };
      projected[rectangleId] = rectangle;
      quadrants.push(rectangleId);
    }
    ids.set(id, quadrants);
    delete projected[id];
  }
  const projectedPopulations: PopulationMap = {};
  for (const [id, population] of Object.entries(populations)) {
    projectedPopulations[id] = {
      ...population,
      gate_refs: population.gate_refs.map((ref) => {
        const quadrants = ids.get(ref.gate_id);
        if (!quadrants) return ref;
        const { quadrant, ...rest } = ref;
        const q = quadrant === undefined || !Number.isFinite(quadrant) ? 1 : Math.trunc(quadrant);
        if (q < 1 || q > 4) throw new Error(`The quadrant reference in "${population.name}" must select quadrant 1, 2, 3 or 4.`);
        return { ...rest, gate_id: quadrants[q - 1] };
      }),
    };
  }
  return { gates: projected, gate_order: gate_order.flatMap((id) => ids.get(id) ?? [id]), populations: projectedPopulations, regions: ids };
}

interface QuadrantRecord {
  /** The quadrant gate's name. */
  name: string;
  /** The gating:id of its regions' rectangles, Q1 (x below, y above the centre) to Q4. */
  regions: [string, string, string, string];
}

/**
 * The document custom_info lines recording which rectangles are one quadrant gate's regions, for
 * every straight quadrant whose four regions were all written; none when there is none.
 */
export function quadrantRecordLines(
  gates: Record<string, Gate>,
  regions: ReadonlyMap<string, readonly string[]>,
  gateToGmlId: ReadonlyMap<string, string>,
): string[] {
  const quadrants: Record<string, QuadrantRecord> = {};
  for (const [id, rects] of regions) {
    const gate = gates[id];
    const gml = rects.map((r) => gateToGmlId.get(r));
    if (!gate || gml.length !== 4 || gml.some((g) => !g)) continue;
    quadrants[id] = { name: gate.name, regions: gml as QuadrantRecord["regions"] };
  }
  if (!Object.keys(quadrants).length) return [];
  const text = JSON.stringify({ version: 1, quadrants })
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return [
    `    <${GATINGML_QUADRANTS_TAG}>`,
    `      <definition>${text}</definition>`,
    `    </${GATINGML_QUADRANTS_TAG}>`,
  ];
}

/** The quadrant records in a document's custom_info; empty when it has none or they are malformed. */
export function parseQuadrantRecords(root: Element): QuadrantRecord[] {
  const local = (el: Element | null, name: string): Element | null => {
    for (let c = el?.firstElementChild ?? null; c; c = c.nextElementSibling) if (c.localName === name) return c;
    return null;
  };
  const def = local(local(local(root, "custom_info"), GATINGML_QUADRANTS_TAG), "definition");
  if (!def) return [];
  try {
    const parsed = JSON.parse(def.textContent ?? "") as { version?: number; quadrants?: Record<string, unknown> };
    if (parsed.version !== 1) return [];
    return Object.values(parsed.quadrants ?? {}).flatMap((value) => {
      const v = value as Partial<QuadrantRecord>;
      return typeof v?.name === "string" && Array.isArray(v.regions) && v.regions.length === 4 && v.regions.every((r) => typeof r === "string")
        ? [{ name: v.name, regions: v.regions as QuadrantRecord["regions"] }]
        : [];
    });
  } catch {
    return [];
  }
}

/**
 * Put each recorded straight quadrant gate back together from its four region rectangles, as
 * imported: only where all four came back as half-open rectangles on the same channels, space and
 * transforms, each open to infinity on its outer sides and meeting the others at one centre.
 * Those four rectangles and the quadrant hold the same events (gates.ts: gateMaskQuadrant puts an
 * event on the centre's line on its upper or right side, as a half-open rectangle's lower bound
 * does), so nothing moves. A file edited elsewhere so that they no longer fit keeps its
 * rectangles. Populations that used a region take the quadrant, NOT included. In place.
 */
export function restoreStraightQuadrants(
  records: readonly QuadrantRecord[],
  gmlToApp: Readonly<Record<string, string>>,
  gates: Record<string, Gate>,
  gateOrder: string[],
  populations: PopulationMap,
): number {
  let restored = 0;
  for (const record of records) {
    const appIds = record.regions.map((gml) => gmlToApp[gml]);
    if (appIds.some((id) => !id) || new Set(appIds).size !== 4) continue;
    const rects = appIds.map((id) => gates[id]);
    if (rects.some((g) => !g || g.gate_type !== "rectangle" || g.bounds !== "half-open")) continue;
    const [first] = rects as PolyRectGate[];
    const sameAxes = (rects as PolyRectGate[]).every((g) =>
      g.x_channel === first.x_channel && g.y_channel === first.y_channel && (g.space ?? "raw") === (first.space ?? "raw")
      && JSON.stringify(g.transforms ?? null) === JSON.stringify(first.transforms ?? null));
    if (!sameAxes) continue;
    // Each region's centre corner and its outer sides, from its own extent.
    let center: [number, number] | null = null;
    let fits = true;
    (rects as PolyRectGate[]).forEach((g, i) => {
      const q = i + 1;
      const xs = g.vertices.map((v) => v[0]), ys = g.vertices.map((v) => v[1]);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      const right = q === 2 || q === 3, up = q === 1 || q === 2;
      const c: [number, number] = [right ? x0 : x1, up ? y0 : y1];
      const outer = [right ? x1 : x0, up ? y1 : y0];
      if (!outer.every(isUnbounded) || !c.every(Number.isFinite)) fits = false;
      if (!center) center = c;
      else if (center[0] !== c[0] || center[1] !== c[1]) fits = false;
    });
    if (!fits || !center) continue;
    const id = appIds[0];
    const { vertices: _v, bounds: _b, gate_type: _t, ...base } = first;
    void _v; void _b; void _t;
    gates[id] = { ...base, gate_id: id, name: record.name, gate_type: "quadrant", center, label_offset: null };
    for (const other of appIds.slice(1)) delete gates[other];
    const firstAt = Math.min(...appIds.map((a) => gateOrder.indexOf(a)).filter((i) => i >= 0));
    const kept = gateOrder.filter((g) => !appIds.includes(g));
    kept.splice(Math.min(firstAt, kept.length), 0, id);
    gateOrder.splice(0, gateOrder.length, ...kept);
    for (const pop of Object.values(populations)) {
      if (!pop.gate_refs.some((ref) => appIds.includes(ref.gate_id))) continue;
      pop.gate_refs = pop.gate_refs.map((ref) => {
        const q = appIds.indexOf(ref.gate_id);
        return q < 0 ? ref : newGateRef(id, ref.include, q + 1);
      });
    }
    restored++;
  }
  return restored;
}
