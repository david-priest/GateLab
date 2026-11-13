// The population edit template GateLab writes reads back as no change when left untouched, also
// for names the reader would otherwise take as a quadrant, a gate id, or a trimmed population name.
import { describe, expect, it } from "vitest";
import { parsePopulationEditTable, serializePopulationEditTemplate } from "./populationTable";
import type { Gate, PopulationMap } from "./models";

function gate(id: string, name: string, quadrant: boolean): Gate {
  return quadrant
    ? { gate_id: id, name, gate_type: "quadrant", x_channel: "FL1-A", y_channel: "FL2-A", center: [1, 1], color: "#000000", label_offset: null }
    : { gate_id: id, name, gate_type: "polygon", x_channel: "FL1-A", y_channel: "FL2-A", vertices: [[0, 0], [1, 0], [1, 1]], color: "#000000", label_offset: null };
}

function onePopulation(name: string, gates: Record<string, Gate>, gateId: string) {
  const populations: PopulationMap = {
    root: { population_id: "root", name: "All Events", gate_refs: [], gate_logic: "and", parent_id: null, children: ["a"], event_count: null, percent_of_parent: null },
    a: { population_id: "a", name, gate_refs: [{ gate_id: gateId, include: true }], gate_logic: "and", parent_id: "root", children: [], event_count: null, percent_of_parent: null },
  };
  return { populations, gates, rootPopulationId: "root" };
}

function readBackUntouched(state: ReturnType<typeof onePopulation>) {
  const preview = parsePopulationEditTable(serializePopulationEditTemplate(state), state);
  expect(preview.renameCount).toBe(0);
  expect(preview.gateDefinitionCount).toBe(0);
  return preview.updates.find((u) => u.popId === "a")!;
}

// Same generator as mulberry32 in the round-trip hunt: a seeded, repeatable stream.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = ["CD4", "CD8", "_positive", " [Q1]", " [q2]", " {g1}", "{", "}", ",", "\\", "\"", "é", "\n", "'", "Q1", " ", "a b"];

describe("population edit template read back untouched", () => {
  it("a population named ' CD4_positive ' keeps its name", () => {
    const update = readBackUntouched(onePopulation(" CD4_positive ", { g1: gate("g1", "CD4", false) }, "g1"));
    expect(update.name).toBe(" CD4_positive ");
  });

  it("a polygon gate named 'CD3 {live}' stays that gate", () => {
    const update = readBackUntouched(onePopulation("T", { g1: gate("g1", "CD3 {live}", false) }, "g1"));
    expect(update.gateRefs).toEqual([{ gate_id: "g1", include: true }]);
  });

  it("a polygon named 'CD4 [Q2]' beside a quadrant gate named 'CD4' stays the polygon", () => {
    const update = readBackUntouched(onePopulation("CD4_positive", { q: gate("q", "CD4", true), p: gate("p", "CD4 [Q2]", false) }, "p"));
    expect(update.gateRefs).toEqual([{ gate_id: "p", include: true }]);
  });

  it("a polygon named 'CD4 {g0}' beside a gate g0 named 'CD4' stays the polygon", () => {
    const update = readBackUntouched(onePopulation("CD4_positive", { g0: gate("g0", "CD4", false), p: gate("p", "CD4 {g0}", false) }, "p"));
    expect(update.gateRefs).toEqual([{ gate_id: "p", include: true }]);
  });

  it("500 seeded trees with awkward gate names read back as no change", () => {
    const rand = mulberry32(2026);
    const failures: string[] = [];
    for (let iter = 0; iter < 500; iter++) {
      const gates: Record<string, Gate> = {};
      const ng = 1 + Math.floor(rand() * 4);
      for (let i = 0; i < ng; i++) {
        let name = "";
        const n = 1 + Math.floor(rand() * 3);
        for (let k = 0; k < n; k++) name += PIECES[Math.floor(rand() * PIECES.length)];
        gates[`g${i}`] = gate(`g${i}`, name.trim() || "CD4", rand() < 0.4);
      }
      const populations: PopulationMap = {
        root: { population_id: "root", name: "All Events", gate_refs: [], gate_logic: "and", parent_id: null, children: [], event_count: null, percent_of_parent: null },
      };
      const np = 1 + Math.floor(rand() * 4);
      for (let p = 0; p < np; p++) {
        const id = `p${p}`;
        const refs = Object.values(gates).filter(() => rand() < 0.5).map((g) =>
          g.gate_type === "quadrant" ? { gate_id: g.gate_id, include: true, quadrant: 1 + Math.floor(rand() * 4) } : { gate_id: g.gate_id, include: true });
        const name = rand() < 0.2 ? ` Pop ${p} ` : `Pop ${p}`;
        populations[id] = { population_id: id, name, gate_refs: refs, gate_logic: "and", parent_id: "root", children: [], event_count: null, percent_of_parent: null };
        populations.root.children.push(id);
      }
      const state = { populations, gates, rootPopulationId: "root" };
      const label = `${iter}: ${JSON.stringify(Object.values(gates).map((g) => [g.gate_id, g.gate_type, g.name]))}`;
      try {
        const preview = parsePopulationEditTable(serializePopulationEditTemplate(state), state);
        for (const u of preview.updates) {
          const before = populations[u.popId];
          if (JSON.stringify(u.gateRefs) !== JSON.stringify(before.gate_refs) || u.name !== before.name) {
            failures.push(`changed ${label}`);
          }
        }
      } catch (e) {
        failures.push(`refused ${label}: ${(e as Error).message}`);
      }
    }
    expect(failures.slice(0, 6)).toEqual([]);
  });
});
