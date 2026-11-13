// @vitest-environment jsdom
// The .cef export, counted: a GateLab gate is written, the file is read back as Chorus's gates,
// and the events each population holds are compared with the events GateLab's gate holds.
import { describe, expect, it } from "vitest";
import { cefBytes } from "./chorusExperiment.test";
import { chorusToGatingML, readChorusExperiment } from "./chorusExperiment";
import { exportChorusExperiment, type ChorusExportChannel } from "./chorusExport";
import { importGatingML, type GatingMLResult } from "./gatingml";
import { getGateMask } from "./gates";
import { transformFromSpec } from "./sample";
import { newQuadrantGate, type Gate, type PolyRectGate, type PopulationMap } from "./models";

const CHANNELS = ["Time", "FSC-A", "FSC-H", "FSC-W", "SSC (Imaging)-A", "SSC (Imaging)-H", "BUV805-A", "BV421-A", "PE-A", "BV711-A", "Max Intensity (SSC (Imaging))"];
const channels: ChorusExportChannel[] = CHANNELS.map((c) => ({ key: c, pnn: c }));

/** The S8's display keywords for the colour channels, as chorusExport.test.ts gives them. */
function keywords(): Record<string, string> {
  const kw: Record<string, string> = { $PAR: String(CHANNELS.length) };
  const r: Record<string, string> = { "BUV805-A": "462662", "BV421-A": "54006", "PE-A": "42898", "BV711-A": "21475" };
  CHANNELS.forEach((name, i) => {
    kw[`$P${i + 1}N`] = name;
    kw[`$P${i + 1}R`] = "2147483648";
    if (r[name]) { kw[`P${i + 1}M`] = "7"; kw[`P${i + 1}MS`] = r[name]; }
  });
  return kw;
}

const importTree = (bytes: Uint8Array, kw: Record<string, string>): GatingMLResult =>
  importGatingML(chorusToGatingML(readChorusExperiment(bytes), 0, { keywords: kw }).gatingMl, CHANNELS, {}, "flow");

/** The events of `points` (raw x, y on the gate's own channels) a gate holds. */
function members(gate: Gate, points: [number, number][], quadrant?: number): number[] {
  const column = (channel: string) => {
    const axis = channel === gate.x_channel ? 0 : 1;
    const spec = gate.space === "display" ? gate.transforms?.[channel] : undefined;
    return Float64Array.from(points, (p) => (spec ? transformFromSpec(spec).forward(p[axis]) : p[axis]));
  };
  return Array.from(getGateMask(gate, { n: points.length, column } as never, quadrant));
}

/** A tree with `gate` and its populations added beneath the root. */
function withGate(tree: GatingMLResult, gate: Gate, pops: { id: string; name: string; quadrant?: number }[]) {
  const root = tree.populations[tree.root_population_id];
  const populations: PopulationMap = { ...tree.populations };
  for (const pop of pops) {
    populations[pop.id] = {
      population_id: pop.id, name: pop.name, gate_logic: "and", parent_id: root.population_id, children: [], event_count: null, percent_of_parent: null,
      gate_refs: [{ gate_id: gate.gate_id, include: true, ...(pop.quadrant ? { quadrant: pop.quadrant } : {}) }],
    };
  }
  populations[root.population_id] = { ...root, children: [...root.children, ...pops.map((pop) => pop.id)] };
  return { gates: { ...tree.gates, [gate.gate_id]: gate } as Record<string, Gate>, populations };
}

/** The gate of the population named `name` in a tree read back from a .cef. */
function gateOf(tree: GatingMLResult, name: string): Gate {
  const pop = Object.values(tree.populations).find((p) => p.name === name);
  expect(pop, `population "${name}" in the exported file`).toBeDefined();
  return tree.gates[pop!.gate_refs[0].gate_id];
}

describe("the .cef export, counted", () => {
  it("writes a rectangle held as four corners with its height", () => {
    const source = cefBytes();
    const kw = keywords();
    const tree = importTree(source, kw);
    const singlets = Object.values(tree.gates).find((g) => g.name === "Singlets") as PolyRectGate;
    expect(singlets.vertices).toHaveLength(4);
    // FSC-W from 1000 to 3000: one event inside, one below and one above.
    const xs = singlets.vertices.map((v) => v[0]);
    const x = (Math.min(...xs) + Math.max(...xs)) / 2;
    const events: [number, number][] = [[x, 2000], [x, 500], [x, 3500]];
    expect(members(singlets, events)).toEqual([1, 0, 0]);
    const result = exportChorusExperiment({ source, channels, keywords: kw, gates: tree.gates, populations: tree.populations, root_population_id: tree.root_population_id });
    expect(members(gateOf(importTree(result.bytes, kw), "Singlets"), events)).toEqual([1, 0, 0]);
  });

  it("writes each quadrant population as its own quadrant", () => {
    const source = cefBytes();
    const kw = keywords();
    const tree = importTree(source, kw);
    const quad = newQuadrantGate("CD4_CD8", "FSC-A", "SSC (Imaging)-A", [100000, 100000]);
    const added = withGate(tree, quad, [1, 2, 3, 4].map((q) => ({ id: `pop-q${q}`, name: `Q${q}_cells`, quadrant: q })));
    // One event in each quadrant: Q1 x- y+, Q2 x+ y+, Q3 x+ y-, Q4 x- y-.
    const events: [number, number][] = [[50000, 150000], [150000, 150000], [150000, 50000], [50000, 50000]];
    const result = exportChorusExperiment({ source, channels, keywords: kw, ...added, root_population_id: tree.root_population_id });
    expect(result.skipped).toEqual([]);
    const back = importTree(result.bytes, kw);
    for (const q of [1, 2, 3, 4]) {
      const held = members(quad, events, q);
      expect(held).toEqual(events.map((_, i) => (i === q - 1 ? 1 : 0)));
      expect(members(gateOf(back, `Q${q}_cells`), events), `Q${q}`).toEqual(held);
    }
  });

  it("traces a polygon drawn in GateLab's own logicle into Chorus's display", () => {
    const source = cefBytes();
    const kw = keywords();
    const tree = importTree(source, kw);
    const logicle = { kind: "logicle" as const, T: 262144, W: 0.5, M: 4.5, A: 0 };
    const forward = transformFromSpec(logicle).forward;
    const corners: [number, number][] = [[-200, -200], [100000, -200], [-200, 100000]];
    const gate: PolyRectGate = {
      gate_id: "drawn-1", name: "CD8_low", gate_type: "polygon", x_channel: "PE-A", y_channel: "BV711-A", space: "display",
      vertices: corners.map(([x, y]) => [forward(x), forward(y)] as [number, number]), transforms: { "PE-A": logicle, "BV711-A": logicle }, color: "#000000", label_offset: null,
    };
    const added = withGate(tree, gate, [{ id: "pop-drawn", name: "CD8_low" }]);
    const result = exportChorusExperiment({ source, channels, keywords: kw, ...added, root_population_id: tree.root_population_id });
    const back = gateOf(importTree(result.bytes, kw), "CD8_low") as PolyRectGate;
    // The two axis-aligned edges are straight in any display; the third is traced.
    expect(back.vertices.length).toBeGreaterThan(3);
    // 40,401 events on a log-spaced grid from 0 to 100,000 on both channels.
    const events: [number, number][] = [];
    for (let i = 0; i <= 200; i++) for (let j = 0; j <= 200; j++) events.push([10 ** (i / 40) - 1, 10 ** (j / 40) - 1]);
    const held = members(gate, events), read = members(back, events);
    const count = held.reduce((n, v) => n + v, 0);
    const differing = held.filter((v, i) => v !== read[i]).length;
    expect(count).toBe(22767);
    // Written as its three corners, 15,952 of these events changed side; traced, 7 do.
    expect(differing).toBeLessThanOrEqual(10);
  });
});
