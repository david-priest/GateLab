// Straight quadrant regions are open-ended, half-open rectangles. Project a temporary
// export tree so each (gate, quadrant) reference has its own primitive, including NOT refs.
import { UNBOUNDED, type Gate, type PopulationMap, type PolyRectGate } from "./models";
import { curlBends } from "./gates";

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
): { gates: Record<string, Gate>; gate_order: string[]; populations: PopulationMap } {
  const straight = gate_order.filter((id) => gates[id]?.gate_type === "quadrant" && !isCurvedQuadrant(gates[id]));
  if (!straight.length) return { gates, gate_order, populations };
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
  return { gates: projected, gate_order: gate_order.flatMap((id) => ids.get(id) ?? [id]), populations: projectedPopulations };
}
