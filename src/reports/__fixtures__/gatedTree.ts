// gatedTree.ts — a synthetic file gated by the engine, for the report tests. Each population is one
// rectangle gate on channels x and y, drawn with half-integer bounds so no event lies on an edge,
// and the masks come from applyGatingStrategy exactly as the app's do.

import type { AssayData } from "../../engine/gates";
import type { Gate, PopulationMap } from "../../engine/models";
import { applyGatingStrategy } from "../../engine/populations";
import type { FileGating } from "../membershipExport";

export interface PopulationSpec {
  id: string;
  name: string;
  /** The parent's id; null for a population directly under the root. */
  parent: string | null;
  /** Inclusive x range of the rectangle; y defaults to everything. */
  x: [number, number];
  y?: [number, number];
}

export const ROOT_ID = "root";

/** Twenty events: x = 0..19, y = 0 for even events and 10 for odd ones. */
export function syntheticAssay(): AssayData {
  const n = 20;
  const x = Float32Array.from({ length: n }, (_, i) => i);
  const y = Float32Array.from({ length: n }, (_, i) => (i % 2 ? 10 : 0));
  return { n, column: (ch) => (ch === "x" ? x : ch === "y" ? y : undefined) };
}

/** Gate the synthetic events with one rectangle per population. */
export function gatedTree(specs: readonly PopulationSpec[], data: AssayData = syntheticAssay()): FileGating {
  const gates: Record<string, Gate> = {};
  const populations: PopulationMap = {
    [ROOT_ID]: {
      population_id: ROOT_ID, name: "All events", gate_refs: [], gate_logic: "and", parent_id: null, children: [],
      event_count: null, percent_of_parent: null,
    },
  };
  for (const spec of specs) {
    const [yMin, yMax] = spec.y ?? [-1000, 1000];
    gates[`g_${spec.id}`] = {
      gate_id: `g_${spec.id}`,
      name: spec.name,
      gate_type: "rectangle",
      x_channel: "x",
      y_channel: "y",
      vertices: [[spec.x[0] - 0.5, yMin - 0.5], [spec.x[1] + 0.5, yMax + 0.5]],
      color: "#000000",
      label_offset: null,
    };
    const parent = spec.parent ?? ROOT_ID;
    populations[spec.id] = {
      population_id: spec.id, name: spec.name, gate_refs: [{ gate_id: `g_${spec.id}`, include: true }], gate_logic: "and",
      parent_id: parent, children: [], event_count: null, percent_of_parent: null,
    };
    populations[parent].children.push(spec.id);
  }
  const { masks } = applyGatingStrategy(gates, populations, ROOT_ID, data);
  return { populations, rootPopulationId: ROOT_ID, masks };
}

/** The indices of the events a mask holds. */
export const members = (mask: Uint8Array): number[] => {
  const out: number[] = [];
  mask.forEach((bit, i) => { if (bit) out.push(i); });
  return out;
};
