// @vitest-environment jsdom
//
// The FlowJo 11 workbench round trip: GateLab's tree written as a .flowjo (flowjo11Export.ts), read
// back by GateLab's own .flowjo reader (flowjo11Workbench.ts) onto the same FCS file as the app
// imports it, and every population counted. Each gate is drawn around events placed at known
// positions, well inside or outside it, and its count asserted before and after. Every name is
// synthetic.

import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FLOWJO11_WORKBENCH_DIR } from "../testFixtures";
import { parseFcs } from "./fcs";
import { writeFcs } from "./fcsExport";
import { Sample } from "./sample";
import { exportFlowJo11Workbench, type FlowJo11ExportSample } from "./flowjo11Export";
import { flowJo11WorkbenchToWorkspace, readFlowJo11Workbench, FLOWJO11_CURLY_QUAD_CURL } from "./flowjo11Workbench";
import { applyGatingStrategy } from "./populations";
import { flowJoWorkspaceToGatingML, listFlowJoWorkspaceSamples } from "./flowjoWorkspace";
import { importGatingML } from "./gatingml";
import { biexBreakpoints, biexTransform, FLOWJO_BIEX_TABLE_CHANNELS } from "./biex";
import {
  linkChildToParent, newGate, newGateRef, newPopulation, newQuadrantGate, newRootPopulation, UNBOUNDED,
  type EllipseGate, type Gate, type PopulationMap, type TransformSpec, type Vertex,
} from "./models";
import { importGatingOnto, memberships, treePopulations } from "../headless/headless";

const RANGE = 262144;
const CHANNELS = ["FSC-A", "SSC-A", "FL1-A", "FL2-A", "FL3-A", "Time"];
const BIEX: TransformSpec = { kind: "biex", maxValue: RANGE, pos: 4.5, neg: 0, widthBasis: -100, channelRange: 256, tableChannels: FLOWJO_BIEX_TABLE_CHANNELS };
const biex = biexTransform({ maxValue: RANGE, pos: 4.5, neg: 0, widthBasis: -100, channelRange: 256, tableChannels: FLOWJO_BIEX_TABLE_CHANNELS });
/** Raw value at a biex display position (0 to 256). */
const atBiex = (d: number) => biex.inverse(d);

type Point = Partial<Record<(typeof CHANNELS)[number], number>>;

/** An FCS file of the given events, with a spillover matrix over FL1–FL3 when asked. */
function fcsBytes(events: Point[], spill = false): Uint8Array {
  const columns = CHANNELS.map((c) => Float32Array.from(events.map((e, i) => e[c] ?? (c === "Time" ? i * 10 : 1000))));
  const keywords: [string, string][] = [["$CYT", "Synthetic cytometer"], ["$TIMESTEP", "0.01"]];
  if (spill) keywords.push(["$SPILLOVER", "3,FL1-A,FL2-A,FL3-A,1,0.1,0,0.05,1,0.02,0,0,1"]);
  return writeFcs(columns, CHANNELS.map((name) => ({ name, desc: "", range: RANGE })), { keywords });
}

function openSample(bytes: Uint8Array): Sample {
  return new Sample(parseFcs(bytes.slice().buffer as ArrayBuffer));
}

class Tree {
  gates: Record<string, Gate> = {};
  gate_order: string[] = [];
  populations: PopulationMap;
  root: string;
  constructor() {
    const root = newRootPopulation();
    this.populations = { [root.population_id]: root };
    this.root = root.population_id;
  }
  gate<G extends Gate>(g: G): G {
    this.gates[g.gate_id] = g;
    this.gate_order.push(g.gate_id);
    return g;
  }
  pop(name: string, refs: { gate: Gate; include?: boolean; quadrant?: number }[], parent = this.root, logic: "and" | "or" = "and"): string {
    const p = newPopulation(name, refs.map((r) => newGateRef(r.gate.gate_id, r.include ?? true, r.quadrant)), parent, logic);
    this.populations[p.population_id] = p;
    this.populations = linkChildToParent(this.populations, p.population_id, parent);
    return p.population_id;
  }
  entry(sample: Sample, fileName: string): FlowJo11ExportSample {
    return { sample, fileName, gates: structuredClone(this.gates), gate_order: [...this.gate_order], populations: structuredClone(this.populations), root_population_id: this.root };
  }
}

/** Each population's member events by its path, the root left out. */
function byPath(tree: { gates: Record<string, Gate>; populations: PopulationMap; root_population_id: string }, masks: Record<string, Uint8Array>): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  const visit = (id: string, path: string) => {
    const pop = tree.populations[id];
    if (!pop) return;
    if (path) out[path] = Array.from(masks[id] ?? []).flatMap((m, i) => (m ? [i] : []));
    for (const c of pop.children) visit(c, `${path}/${tree.populations[c]?.name}`);
  };
  visit(tree.root_population_id, "");
  return out;
}

const ids = () => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
};

/**
 * Export the entries, then read the workbench back onto each file as the app imports a .flowjo
 * onto one file, and give each file's populations before and after, by path.
 */
function roundTrip(entries: FlowJo11ExportSample[], files: Uint8Array[]) {
  const result = exportFlowJo11Workbench({ samples: entries, fcsFolder: "/Users/D1/data", name: "synthetic", uuid: ids() });
  const text = flowJo11WorkbenchToWorkspace(readFlowJo11Workbench(result.bytes));
  const files_ = entries.map((e, i) => {
    const before = byPath(e, applyGatingStrategy(e.gates, e.populations, e.root_population_id, e.sample.gateAssayData()).masks);
    const g = importGatingOnto(openSample(files[i]), e.fileName, text, "synthetic.flowjo");
    const after: Record<string, number[]> = {};
    const masks = memberships(g);
    for (const p of treePopulations(g.tree)) after[`/${p.path.join("/")}`] = Array.from(masks[p.id]).flatMap((m, j) => (m ? [j] : []));
    return { before, after, refusals: g.refusals, tree: g.tree };
  });
  return { result, text, files: files_ };
}

describe("a FlowJo 11 workbench as FlowJo 11 writes one", () => {
  const t = new Tree();
  const r = t.gate(newGate("Cells", "rectangle", "FSC-A", "SSC-A", [[20000, 30000], [120000, 30000], [120000, 150000], [20000, 150000]]));
  t.pop("Cells", [{ gate: r }]);
  const bytes = fcsBytes([{ "FSC-A": 50000, "SSC-A": 60000 }, { "FSC-A": 200000, "SSC-A": 60000 }]);
  const { result } = roundTrip([t.entry(openSample(bytes), "D1.fcs")], [bytes]);
  const entries = unzipSync(result.bytes);
  const analysis = result.analysis as Record<string, Record<string, { definition: Record<string, unknown>; parents: Record<string, string[]>; children: Record<string, string[]> }>>;

  it("is a zip of the workbench, its preferences and one analysis with its manifest", () => {
    const names = Object.keys(entries).sort();
    expect(names).toHaveLength(4);
    expect(names).toContain("workbench.json");
    expect(names).toContain("preferences.json");
    const wb = JSON.parse(strFromU8(entries["workbench.json"]));
    expect(wb.name).toBe("synthetic");
    expect(names).toContain(`analyses/analysis-${wb.analyses[0]}/analysis-${wb.analyses[0]}.json`);
    expect(strFromU8(entries[`analyses/analysis-${wb.analyses[0]}/analysis-${wb.analyses[0]}_manifest.txt`])).toBe("[]");
    expect(JSON.parse(strFromU8(entries["preferences.json"]))).toEqual({ version: "4.0.0" });
  });

  it("holds FlowJo 11's default groups, parameter sets, table, chart and report", () => {
    const groups = Object.values(analysis.groups).map((g) => g.definition.name);
    expect(groups).toEqual(["Acquired Data", "Compensation Data", "Experiment Data"]);
    expect(Object.keys(analysis.paramsetDefinitions)).toHaveLength(8);
    expect(Object.keys(analysis.compoundParameterSets)).toHaveLength(24);
    expect(Object.keys(analysis.reports)).toHaveLength(1);
    const platforms = analysis.platforms as unknown as Record<string, Record<string, { definition: Record<string, unknown> }>>;
    expect(Object.values(platforms.statisticalModeling).map((p) => p.definition.name)).toEqual(["Table", "Chart"]);
  });

  it("links every node both ways", () => {
    const all = new Map<string, { parents: Record<string, string[]>; children: Record<string, string[]> }>();
    for (const [key, coll] of Object.entries(analysis)) {
      if (!coll || typeof coll !== "object" || key === "platforms") continue;
      for (const n of Object.values(coll)) all.set((n as unknown as { uuid: string }).uuid, n);
    }
    for (const group of Object.values(analysis.platforms as unknown as Record<string, Record<string, { uuid: string; parents: Record<string, string[]>; children: Record<string, string[]> }>>)) {
      for (const n of Object.values(group)) all.set(n.uuid, n);
    }
    for (const [id, n] of all) {
      for (const kids of Object.values(n.children)) {
        for (const k of kids) expect(Object.values(all.get(k)!.parents).flat()).toContain(id);
      }
    }
  });

  it("names the FCS file by its absolute path in the folder given, and stores GateLab's counts", () => {
    const ds = Object.values(analysis.dataSources)[0];
    expect(ds.definition.uri).toBe("/Users/D1/data/D1.fcs");
    expect((ds.definition.customKeywords as Record<string, string>)["File Name"]).toBe("D1.fcs");
    const cells = Object.values(analysis.populations).find((p) => {
      const def = analysis.populationDefinitions[p.parents.populationDefinitions[0]];
      return (def.definition.name as string[])[0] === "Cells";
    }) as unknown as { results: { count: number } };
    expect(cells.results.count).toBe(1);
  });
});

describe("gates drawn around known events, counted before and after", () => {
  it("a rectangle and a polygon on linear scatter, in raw values", () => {
    const t = new Tree();
    const r = t.gate(newGate("Cells", "rectangle", "FSC-A", "SSC-A", [[20000, 30000], [120000, 30000], [120000, 150000], [20000, 150000]]));
    const cells = t.pop("Cells", [{ gate: r }]);
    const p = t.gate(newGate("Singlets", "polygon", "FSC-A", "SSC-A", [[30000, 40000], [110000, 40000], [70000, 140000]]));
    t.pop("Singlets", [{ gate: p }], cells);
    const events: Point[] = [
      { "FSC-A": 70000, "SSC-A": 60000 }, // in both
      { "FSC-A": 25000, "SSC-A": 140000 }, // in Cells, outside the triangle
      { "FSC-A": 200000, "SSC-A": 60000 }, // outside both
      { "FSC-A": 70000, "SSC-A": 120000 }, // in both
    ];
    const bytes = fcsBytes(events);
    const { files, result } = roundTrip([t.entry(openSample(bytes), "D1.fcs")], [bytes]);
    expect(files[0].before["/Cells"]).toEqual([0, 1, 3]);
    expect(files[0].before["/Cells/Singlets"]).toEqual([0, 3]);
    expect(files[0].after).toEqual(files[0].before);
    expect(files[0].refusals).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("a polygon and an ellipse on biex axes and a rectangle on a log axis, exactly where they were drawn", () => {
    const t = new Tree();
    const poly = t.gate({ ...newGate("CD4_positive", "polygon", "FL1-A", "FL2-A", [[100, 100], [200, 100], [200, 200], [100, 200]]), space: "display" as const, transforms: { "FL1-A": BIEX, "FL2-A": BIEX } });
    t.pop("CD4_positive", [{ gate: poly }]);
    const ell: EllipseGate = {
      gate_id: "e1", name: "E1", gate_type: "ellipse", x_channel: "FL1-A", y_channel: "FL2-A", mean: [60, 60],
      covariance: [[400, 150], [150, 225]], distance_square: 1, space: "display", transforms: { "FL1-A": BIEX, "FL2-A": BIEX }, color: "#000", label_offset: null,
    };
    t.gate(ell);
    t.pop("E1", [{ gate: ell }]);
    const LOG: TransformSpec = { kind: "wsplog", offset: 10, decades: 4.5 };
    // Log display fraction 0.5 is 10 · 10^2.25 = 1,778; 0.8 is 10 · 10^3.6 = 39,811.
    const lr = t.gate({ ...newGate("Bright", "rectangle", "FL3-A", "SSC-A", [[0.5, 0], [0.8, 0], [0.8, 200000], [0.5, 200000]]), space: "display" as const, transforms: { "FL3-A": LOG, "SSC-A": { kind: "identity" } } });
    t.pop("Bright", [{ gate: lr }]);
    const events: Point[] = [
      { "FL1-A": atBiex(150), "FL2-A": atBiex(150), "FL3-A": 5000, "SSC-A": 1000 }, // CD4_positive, Bright
      { "FL1-A": atBiex(60), "FL2-A": atBiex(60), "FL3-A": 1000, "SSC-A": 1000 }, // E1 (its centre)
      { "FL1-A": atBiex(75), "FL2-A": atBiex(70), "FL3-A": 30000, "SSC-A": 1000 }, // E1, Bright
      { "FL1-A": atBiex(30), "FL2-A": atBiex(90), "FL3-A": 100000, "SSC-A": 1000 }, // nowhere
    ];
    const bytes = fcsBytes(events);
    const { files, result } = roundTrip([t.entry(openSample(bytes), "D1.fcs")], [bytes]);
    expect(files[0].before["/CD4_positive"]).toEqual([0]);
    expect(files[0].before["/E1"]).toEqual([1, 2]);
    expect(files[0].before["/Bright"]).toEqual([0, 2]);
    expect(files[0].after).toEqual(files[0].before);
    expect(result.warnings).toEqual([]);
    // The ellipse is FlowJo 11's ellipse, not a traced polygon; the log rectangle keeps its axis.
    const defs = Object.values(result.analysis.populationDefinitions as Record<string, { definition: { name: string[]; gateDefinition?: { type: string; xAxis: { transform: { transformType: string } } } } }>);
    expect(defs.find((d) => d.definition.name[0] === "E1")!.definition.gateDefinition!.type).toBe("ellipse");
    expect(defs.find((d) => d.definition.name[0] === "Bright")!.definition.gateDefinition!.xAxis.transform.transformType).toBe("Log");
  });

  it("an ellipse's events that FlowJo 11, testing each at the middle of its channel, places otherwise are named", () => {
    // A circle of radius 20 display channels about (100, 100) on biex axes. FlowJo 11 tests an event
    // at the middle of its display channel: (119.98, 100.99), just outside, is inside at (119.5,
    // 100.5); (80.95, 105.1), just inside, is outside at (80.5, 105.5).
    const t = new Tree();
    const ell: EllipseGate = {
      gate_id: "c1", name: "C1", gate_type: "ellipse", x_channel: "FL1-A", y_channel: "FL2-A", mean: [100, 100],
      covariance: [[400, 0], [0, 400]], distance_square: 1, space: "display", transforms: { "FL1-A": BIEX, "FL2-A": BIEX }, color: "#000", label_offset: null,
    };
    t.gate(ell);
    t.pop("C1", [{ gate: ell }]);
    const events: Point[] = [
      { "FL1-A": atBiex(119.98), "FL2-A": atBiex(100.99) },
      { "FL1-A": atBiex(80.95), "FL2-A": atBiex(105.1) },
      { "FL1-A": atBiex(100), "FL2-A": atBiex(100) },
      { "FL1-A": atBiex(150), "FL2-A": atBiex(150) },
    ];
    const bytes = fcsBytes(events);
    const { files, result } = roundTrip([t.entry(openSample(bytes), "D1.fcs")], [bytes]);
    expect(files[0].before["/C1"]).toEqual([1, 2]);
    expect(files[0].after).toEqual(files[0].before);
    expect(result.warnings.filter((w) => /tests the ellipse "C1"/.test(w) && /2 events /.test(w))).toHaveLength(1);
  });

  it("an open edge on a biex axis holds the events below the axis's floor", () => {
    const t = new Tree();
    const r = t.gate({ ...newGate("Negative", "rectangle", "FL1-A", "FL2-A", [[-UNBOUNDED, -UNBOUNDED], [atBiex(80), -UNBOUNDED], [atBiex(80), atBiex(80)], [-UNBOUNDED, atBiex(80)]]), flowjo_axes: { "FL1-A": { kind: "biex", maxValue: RANGE, pos: 4.5, neg: 0, widthBasis: -100, channelRange: 256 }, "FL2-A": { kind: "biex", maxValue: RANGE, pos: 4.5, neg: 0, widthBasis: -100, channelRange: 256 } } });
    t.pop("Negative", [{ gate: r }]);
    const events: Point[] = [
      { "FL1-A": -50000, "FL2-A": -50000 }, // far below the biex table
      { "FL1-A": atBiex(40), "FL2-A": atBiex(40) },
      { "FL1-A": atBiex(120), "FL2-A": atBiex(40) },
    ];
    const bytes = fcsBytes(events);
    const { files } = roundTrip([t.entry(openSample(bytes), "D1.fcs")], [bytes]);
    expect(files[0].before["/Negative"]).toEqual([0, 1]);
    expect(files[0].after).toEqual(files[0].before);
  });

  it("a polygon on a logicle display, traced on an axis FlowJo 11 has, and named", () => {
    const t = new Tree();
    const sample = openSample(fcsBytes([{}]));
    const logicle = sample.transformSpec("FL1-A");
    const spec: TransformSpec = logicle.kind === "logicle" ? logicle : { kind: "logicle", T: RANGE, W: 0.5, M: 4.5, A: 0 };
    const poly = t.gate({ ...newGate("Traced", "polygon", "FL1-A", "FL2-A", [[0.4, 0.4], [0.7, 0.4], [0.7, 0.7], [0.4, 0.7]]), space: "display" as const, transforms: { "FL1-A": spec, "FL2-A": spec } });
    t.pop("Traced", [{ gate: poly }]);
    const inv = (v: number) => sample.gateToRaw(poly, "FL1-A", v);
    const events: Point[] = [
      { "FL1-A": inv(0.55), "FL2-A": inv(0.55) },
      { "FL1-A": inv(0.3), "FL2-A": inv(0.55) },
      { "FL1-A": inv(0.65), "FL2-A": inv(0.45) },
    ];
    const bytes = fcsBytes(events);
    const { files, result } = roundTrip([t.entry(openSample(bytes), "D1.fcs")], [bytes]);
    expect(files[0].before["/Traced"]).toEqual([0, 2]);
    expect(files[0].after).toEqual(files[0].before);
    expect(result.warnings.some((w) => /"Traced" is not straight on any axis the workbench can declare/.test(w))).toBe(true);
  });
});

describe("polygons on FlowJo 11's grid", () => {
  /** Raw value of a display channel on the 0 to 262,144 linear axis. */
  const lin = (c: number) => (c * RANGE) / 256;

  it("a FlowJo 10 grid polygon holds FlowJo 10's events: its axis moves by half a channel", () => {
    // FlowJo 10 puts an event on the nearest channel, FlowJo 11 on the one below: 9.6 is channel 10
    // under FlowJo 10 (inside the square from 10 to 40) and 9 under FlowJo 11; 40.6 is 41 (outside)
    // and 40.
    const grid: TransformSpec = { kind: "flowjoChannels", channels: 256, axis: { kind: "linear", minRange: 0, maxRange: RANGE } };
    const t = new Tree();
    const p = t.gate({ ...newGate("FJ10", "polygon", "FSC-A", "SSC-A", [[10, 10], [40, 10], [40, 40], [10, 40]]), space: "display" as const, transforms: { "FSC-A": grid, "SSC-A": grid } });
    t.pop("FJ10", [{ gate: p }]);
    const events: Point[] = [
      { "FSC-A": lin(9.6), "SSC-A": lin(20) },
      { "FSC-A": lin(40.4), "SSC-A": lin(20) },
      { "FSC-A": lin(40.6), "SSC-A": lin(20) },
      { "FSC-A": lin(9.4), "SSC-A": lin(20) },
    ];
    const bytes = fcsBytes(events);
    const { files, result } = roundTrip([t.entry(openSample(bytes), "D1.fcs")], [bytes]);
    expect(files[0].before["/FJ10"]).toEqual([0, 1]);
    expect(files[0].after).toEqual(files[0].before);
    expect(result.warnings).toEqual([]);
  });

  it("names, per file, the events FlowJo 11 tests on the other side of a polygon GateLab holds continuously", () => {
    // A square on biex axes whose left edge is at display 100.8, inside channel 100. FlowJo 11 tests
    // an event of that channel at its lower corner, and the polygon goes out half a channel lower
    // (left edge 100.3) so that the corner stands for the channel's middle, 100.5, which is outside.
    // The event at 100.9 is inside the square GateLab holds and outside FlowJo 11's reading of it.
    const t = new Tree();
    const p = t.gate({ ...newGate("Square", "polygon", "FL1-A", "FL2-A", [[100.8, 100.8], [200, 100.8], [200, 200], [100.8, 200]]), space: "display" as const, transforms: { "FL1-A": BIEX, "FL2-A": BIEX } });
    t.pop("Square", [{ gate: p }]);
    const events: Point[] = [
      { "FL1-A": atBiex(150), "FL2-A": atBiex(150) },
      { "FL1-A": atBiex(100.9), "FL2-A": atBiex(150) },
      { "FL1-A": atBiex(100.5), "FL2-A": atBiex(150) },
      { "FL1-A": atBiex(101.6), "FL2-A": atBiex(150) },
    ];
    const bytes = fcsBytes(events);
    const { files, result } = roundTrip([t.entry(openSample(bytes), "D1.fcs")], [bytes]);
    expect(files[0].before["/Square"]).toEqual([0, 1, 3]);
    expect(files[0].after["/Square"]).toEqual([0, 3]);
    expect(result.warnings).toEqual([
      "D1.fcs: the workbench tests the polygon \"Square\" with each event on its display channel, which puts 1 event of \"All Events\" " +
        "on the other side of it than GateLab (as GateLab's .flowjo import reads the workbench's rule).",
    ]);
  });
});

describe("quadrants", () => {
  // Centre at biex display (100, 100): Q1 (x−, y+), Q2 (x+, y+), Q3 (x+, y−), Q4 (x−, y−).
  const events: Point[] = [
    { "FL1-A": atBiex(50), "FL2-A": atBiex(150) },
    { "FL1-A": atBiex(150), "FL2-A": atBiex(150) },
    { "FL1-A": atBiex(150), "FL2-A": atBiex(50) },
    { "FL1-A": atBiex(50), "FL2-A": atBiex(50) },
    { "FL1-A": -40000, "FL2-A": -40000 },
  ];

  it("a straight crosshair on compensated channels is FlowJo 11's quad, with the matrix linked", () => {
    const t = new Tree();
    const q = t.gate({ ...newQuadrantGate("Q", "FL1-A", "FL2-A", [atBiex(100), atBiex(100)]), space: "raw" as const });
    for (const n of [1, 2, 3, 4]) t.pop(`Q${n}`, [{ gate: q, quadrant: n }]);
    const bytes = fcsBytes(events, true);
    const sample = openSample(bytes);
    sample.setCompensation(true);
    expect(sample.compensationEnabled).toBe(true);
    const { files, result } = roundTrip([t.entry(sample, "D1.fcs")], [bytes]);
    expect(files[0].after).toEqual(files[0].before);
    expect(Object.values(files[0].before).map((v) => v.length).reduce((a, b) => a + b)).toBe(5);
    const a = result.analysis as Record<string, Record<string, { definition: Record<string, unknown>; parents: Record<string, string[]> }>>;
    const quad = Object.values(a.populationDefinitions).find((d) => d.definition.type === "quad")!;
    const g = quad.definition.gateDefinition as { xAxis: { parameterSpec: { name: string } }; xVertices: number[] };
    expect(g.xAxis.parameterSpec.name).toBe("Comp-FL1-A");
    expect(quad.definition.name).toEqual(["Q4", "Q3", "Q1", "Q2"]);
    const matrices = Object.values((a.platforms as unknown as Record<string, Record<string, { uuid: string }>>).spilloverMatrix);
    expect(matrices).toHaveLength(1);
    expect(Object.values(a.dataSources)[0].parents.platforms).toEqual([matrices[0].uuid]);
  });

  it("a crosshair's biex arms go in the middle of the table entry nearest them, and the events FlowJo 11 places otherwise are named", () => {
    // FlowJo 11 tests a quad's biex arm with the event on its 4096-entry table (quadArmEntry). The
    // horizontal arm at display 92.6143 (entry 1481.83) is written mid-entry 1482: the event at entry
    // 1481.4 stays below it, as in GateLab; the one at 1481.9, above GateLab's arm, is below FlowJo
    // 11's, and named.
    const { raw: table } = biexBreakpoints({ maxValue: RANGE, pos: 4.5, neg: 0, widthBasis: -100, channelRange: 256, tableChannels: FLOWJO_BIEX_TABLE_CHANNELS });
    const at = (entry: number) => table[Math.floor(entry)] + (entry - Math.floor(entry)) * (table[Math.floor(entry) + 1] - table[Math.floor(entry)]);
    const t = new Tree();
    const q = t.gate({ ...newQuadrantGate("Q", "FL1-A", "FL2-A", [100, 1481.83 / 16]), space: "display" as const, transforms: { "FL1-A": BIEX, "FL2-A": BIEX } });
    for (const n of [1, 2, 3, 4]) t.pop(`Q${n}`, [{ gate: q, quadrant: n }]);
    const bytes = fcsBytes([{ "FL1-A": at(800), "FL2-A": at(1481.4) }, { "FL1-A": at(800), "FL2-A": at(1481.9) }, { "FL1-A": at(800), "FL2-A": at(1483) }]);
    const { files, result } = roundTrip([t.entry(openSample(bytes), "D1.fcs")], [bytes]);
    expect(files[0].before["/Q1"]).toEqual([1, 2]);
    expect(files[0].after["/Q1"]).toEqual([2]);
    expect(files[0].after["/Q4"]).toEqual([0, 1]);
    const quad = Object.values(result.analysis.populationDefinitions as Record<string, { definition: { type: string; gateDefinition: { xVertices: number[]; yVertices: number[] } } }>)
      .find((d) => d.definition.type === "quad")!.definition.gateDefinition;
    expect(quad.yVertices[0]).toBe(1482.5 / 16);
    expect(quad.xVertices[0]).toBe(1600.5 / 16);
    expect(result.warnings.filter((w) => /tests the quadrant "Q1"/.test(w) && /1 event /.test(w))).toHaveLength(1);
  });

  it("a range's and a biex rectangle's bounds go in the middle of the table entry nearest them, and the events FlowJo 11 places otherwise are named", () => {
    // FlowJo 11 tests a biex range or rectangle with the event on its 4096-entry table, floor(lo × 16)
    // ≤ entry < floor(hi × 16) (flowjo11Workbench.ts). Bounds at entries 1200.3 and 1481.83 are
    // written mid-entry 1200 and 1482: the events at 1200.1 and 1481.9, outside GateLab's bounds, are
    // inside FlowJo 11's, and named; the read-back holds them, as FlowJo 11 would.
    const { raw: table } = biexBreakpoints({ maxValue: RANGE, pos: 4.5, neg: 0, widthBasis: -100, channelRange: 256, tableChannels: FLOWJO_BIEX_TABLE_CHANNELS });
    const at = (entry: number) => table[Math.floor(entry)] + (entry - Math.floor(entry)) * (table[Math.floor(entry) + 1] - table[Math.floor(entry)]);
    const [lo, hi] = [1200.3 / 16, 1481.83 / 16];
    const t = new Tree();
    const shown = { space: "display" as const, transforms: { "FL1-A": BIEX, "FL2-A": BIEX } };
    t.pop("R", [{ gate: t.gate({ ...newGate("R", "rectangle", "FL1-A", "FL1-A", [[lo, lo], [hi, lo], [hi, hi], [lo, hi]]), ...shown }) }]);
    t.pop("B", [{ gate: t.gate({ ...newGate("B", "rectangle", "FL1-A", "FL2-A", [[lo, lo], [hi, lo], [hi, hi], [lo, hi]]), ...shown }) }]);
    const mid = at(1300);
    const bytes = fcsBytes([at(1200.1), at(1200.6), at(1481.4), at(1481.9), at(1490)].map((v) => ({ "FL1-A": v, "FL2-A": mid })));
    const { files, result } = roundTrip([t.entry(openSample(bytes), "D1.fcs")], [bytes]);
    expect(files[0].before["/R"]).toEqual([1, 2]);
    expect(files[0].after["/R"]).toEqual([0, 1, 2, 3]);
    expect(files[0].before["/B"]).toEqual([1, 2]);
    expect(files[0].after["/B"]).toEqual([0, 1, 2, 3]);
    const defs = Object.values(result.analysis.populationDefinitions as Record<string, { definition: { name: string[]; gateDefinition?: { type: string; xVertices: number[]; yVertices: number[] } } }>);
    const range = defs.find((d) => d.definition.name[0] === "R")!.definition.gateDefinition!;
    const rect = defs.find((d) => d.definition.name[0] === "B")!.definition.gateDefinition!;
    expect(range.type).toBe("range");
    expect(range.xVertices).toEqual([1200.5 / 16, 1482.5 / 16]);
    expect(rect.xVertices).toEqual([1200.5 / 16, 1482.5 / 16]);
    expect(rect.yVertices).toEqual([1200.5 / 16, 1482.5 / 16]);
    expect(result.warnings.filter((w) => /tests the range "R"/.test(w) && /2 events /.test(w))).toHaveLength(1);
    expect(result.warnings.filter((w) => /tests the rectangle "B"/.test(w) && /2 events /.test(w))).toHaveLength(1);
  });

  it("a rectangle with a log or linear axis is written where it was drawn: that FlowJo 11 rule was not measured", () => {
    const t = new Tree();
    const r = t.gate({ ...newGate("M", "rectangle", "FL1-A", "SSC-A", [[1200.3 / 16, 1000], [1481.83 / 16, 1000], [1481.83 / 16, 90000], [1200.3 / 16, 90000]]), space: "display" as const, transforms: { "FL1-A": BIEX, "SSC-A": { kind: "identity" } } });
    t.pop("M", [{ gate: r }]);
    const bytes = fcsBytes([{ "FL1-A": atBiex(80), "SSC-A": 5000 }]);
    const { result } = roundTrip([t.entry(openSample(bytes), "D1.fcs")], [bytes]);
    const def = Object.values(result.analysis.populationDefinitions as Record<string, { definition: { name: string[]; gateDefinition?: { xVertices: number[] } } }>)
      .find((d) => d.definition.name[0] === "M")!.definition.gateDefinition!;
    expect(def.xVertices[0]).toBeCloseTo(1200.3 / 16, 6);
    expect(def.xVertices[1]).toBeCloseTo(1481.83 / 16, 6);
    expect(result.warnings).toEqual([]);
  });

  it("FlowJo 11's curly quadrant goes back as its curlyQuad", () => {
    const t = new Tree();
    const grid: TransformSpec = { kind: "flowjoChannels", channels: 256, axis: { kind: "biex", maxValue: RANGE, pos: 4.5, neg: 0, widthBasis: -100, channelRange: 256 }, rule: "flowjo11" };
    const q = t.gate({ ...newQuadrantGate("C", "FL1-A", "FL2-A", [100, 100]), space: "display" as const, transforms: { "FL1-A": grid, "FL2-A": grid }, curl: { ...FLOWJO11_CURLY_QUAD_CURL } });
    for (const n of [1, 2, 3, 4]) t.pop(`C${n}`, [{ gate: q, quadrant: n }]);
    const bytes = fcsBytes(events);
    const { files, result } = roundTrip([t.entry(openSample(bytes), "D1.fcs")], [bytes]);
    expect(files[0].after).toEqual(files[0].before);
    const defs = Object.values(result.analysis.populationDefinitions as Record<string, { definition: { type: string } }>);
    expect(defs.some((d) => d.definition.type === "curlyQuad")).toBe(true);
  });
});

describe("NOT and AND", () => {
  it("links the populations they combine, adding one where the tree has none", () => {
    const t = new Tree();
    const a = t.gate(newGate("A", "rectangle", "FSC-A", "SSC-A", [[0, 0], [100000, 0], [100000, 100000], [0, 100000]]));
    const b = t.gate(newGate("B", "rectangle", "FSC-A", "SSC-A", [[50000, 50000], [200000, 50000], [200000, 200000], [50000, 200000]]));
    t.pop("A", [{ gate: a }]);
    t.pop("Not A", [{ gate: a, include: false }]);
    t.pop("A and B", [{ gate: a }, { gate: b }]);
    t.pop("A not B", [{ gate: a }, { gate: b, include: false }]);
    const events: Point[] = [
      { "FSC-A": 20000, "SSC-A": 20000 }, // A
      { "FSC-A": 70000, "SSC-A": 70000 }, // A and B
      { "FSC-A": 150000, "SSC-A": 150000 }, // B
      { "FSC-A": 250000, "SSC-A": 20000 }, // neither
    ];
    const bytes = fcsBytes(events);
    const { files, result } = roundTrip([t.entry(openSample(bytes), "D1.fcs")], [bytes]);
    const f = files[0];
    expect(f.before["/A"]).toEqual([0, 1]);
    expect(f.before["/Not A"]).toEqual([2, 3]);
    expect(f.before["/A and B"]).toEqual([1]);
    expect(f.before["/A not B"]).toEqual([0]);
    for (const [path, members] of Object.entries(f.before)) expect(f.after[path], path).toEqual(members);
    // B's population and a NOT of it are added beside them, and said.
    expect(f.after["/B"]).toEqual([1, 2]);
    expect(result.warnings.some((w) => /"B" was added under "All Events"/.test(w))).toBe(true);
  });

  it("refuses OR by name", () => {
    const t = new Tree();
    const a = t.gate(newGate("A", "rectangle", "FSC-A", "SSC-A", [[0, 0], [1, 0], [1, 1], [0, 1]]));
    const b = t.gate(newGate("B", "rectangle", "FSC-A", "SSC-A", [[2, 2], [3, 2], [3, 3], [2, 3]]));
    t.pop("A or B", [{ gate: a }, { gate: b }], t.root, "or");
    const bytes = fcsBytes([{}]);
    const result = exportFlowJo11Workbench({ samples: [t.entry(openSample(bytes), "D1.fcs")], fcsFolder: "/Users/D1", name: "x" });
    expect(result.warnings.some((w) => /"A or B" combines gates with OR/.test(w))).toBe(true);
  });
});

describe("files sharing one tree", () => {
  it("writes a gate tailored in one file as that sample's entry in the desyncTable", () => {
    const t = new Tree();
    const r = t.gate(newGate("Cells", "rectangle", "FSC-A", "SSC-A", [[20000, 20000], [100000, 20000], [100000, 100000], [20000, 100000]]));
    t.pop("Cells", [{ gate: r }]);
    const events: Point[] = [{ "FSC-A": 50000, "SSC-A": 50000 }, { "FSC-A": 150000, "SSC-A": 50000 }];
    const files = ["D1.fcs", "D2.fcs", "D3.fcs", "D4.fcs"].map(() => fcsBytes(events));
    const entries = files.map((b, i) => t.entry(openSample(b), `D${i + 1}.fcs`));
    // D3 tailors Cells to reach the second event.
    const tailored = entries[2].gates[r.gate_id] as typeof r;
    tailored.vertices = [[20000, 20000], [200000, 20000], [200000, 100000], [20000, 100000]];
    const { files: out, result } = roundTrip(entries, files);
    expect(out.map((f) => f.before["/Cells"])).toEqual([[0], [0], [0, 1], [0]]);
    expect(out.map((f) => f.after["/Cells"])).toEqual([[0], [0], [0, 1], [0]]);
    const defs = Object.values(result.analysis.populationDefinitions as Record<string, { definition: { name: string[]; desyncTable?: Record<string, unknown> } }>);
    const cells = defs.find((d) => d.definition.name[0] === "Cells")!;
    const sampleIds = Object.keys(result.analysis.dataSources as Record<string, unknown>);
    expect(Object.keys(cells.definition.desyncTable!)).toEqual([sampleIds[2]]);
  });

  it("refuses files gated under trees of different structure, naming them", () => {
    const a = new Tree();
    a.pop("Cells", [{ gate: a.gate(newGate("Cells", "rectangle", "FSC-A", "SSC-A", [[0, 0], [1, 0], [1, 1], [0, 1]])) }]);
    const b = new Tree();
    b.pop("Other", [{ gate: b.gate(newGate("Other", "rectangle", "FSC-A", "SSC-A", [[0, 0], [1, 0], [1, 1], [0, 1]])) }]);
    const bytes = fcsBytes([{}]);
    expect(() => exportFlowJo11Workbench({
      samples: [a.entry(openSample(bytes), "D1.fcs"), b.entry(openSample(bytes), "D2.fcs")], fcsFolder: "/Users/D1", name: "x",
    })).toThrow(/D2\.fcs is gated under another than D1\.fcs/);
  });

  it("needs the FCS folder as an absolute path", () => {
    const t = new Tree();
    const bytes = fcsBytes([{}]);
    expect(() => exportFlowJo11Workbench({ samples: [t.entry(openSample(bytes), "D1.fcs")], fcsFolder: "data", name: "x" })).toThrow(/absolute path/);
  });
});

void ({} as Vertex);

describe("every key FlowJo 11 writes", () => {
  // Against the FlowJo 11 workbenches David saved (private, read at test time, never copied): for
  // each kind of node, every key path every such node holds in all of them must be in the export,
  // with the same JSON type. A group's results without its list of files, which FlowJo 11 refuses
  // ("the file you tried to open is not supported"), is the gap this exists to catch.
  const dir = FLOWJO11_WORKBENCH_DIR;
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".flowjo")) : [];

  /** Keys FlowJo 11 writes and opens its own workbench without, each with the probe that showed it (2026-10-23). */
  const TOLERATED: Array<[RegExp, string]> = [
    [/^dataSources\/ds results\.hash$/, "H5: FlowJo 11's own workbench without the sample hash opens"],
    [/^dataSources\/ds results\.parameters\.unmixed\[\]/, "H3: without the sample's unmixed parameter list it opens"],
    [/^paramsetDefinitions\/[^ ]+ definition\.parameterSpecs/, "H4: without parameterSpecs it opens"],
  ];

  const jsonType = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:[-:]\d+)?$/;
  /** Map keys that are data, not field names: written as <key>. */
  const DATA_KEYED = new Set(["keywords", "fluorToPrimaryDetector", "parameterMappings", "pages"]);

  /**
   * Every key path of a node, with the JSON types it takes there. Keys that are data (ids, keyword
   * and parameter names) are written <key>; an axis's fields are qualified by its transform type,
   * since each type has its own; a gate's per-sample versions (desyncTable) are left out, being
   * gates checked as such.
   */
  function pathsOf(value: unknown, at: string, out: Map<string, Set<string>>, dataKeyed = false): void {
    if (at) (out.get(at) ?? out.set(at, new Set()).get(at)!).add(jsonType(value));
    if (Array.isArray(value)) {
      for (const v of value) pathsOf(v, `${at}[]`, out);
    } else if (value && typeof value === "object") {
      const typed = typeof (value as { transformType?: unknown }).transformType === "string" ? `{${(value as { transformType: string }).transformType}}` : "";
      for (const [k, v] of Object.entries(value)) {
        const key = dataKeyed || UUID.test(k) || k.includes(" :: ") ? "<key>" : k;
        if (k === "desyncTable") {
          (out.get(`${at}.${k}`) ?? out.set(`${at}.${k}`, new Set()).get(`${at}.${k}`)!).add(jsonType(v));
          continue;
        }
        pathsOf(v, at ? `${at}${typed}.${key}` : key, out, DATA_KEYED.has(k));
      }
    }
  }

  type NodeJson = { definition?: Record<string, unknown>; parents?: Record<string, string[]>; [k: string]: unknown };
  /** Each node of an analysis by kind: its collection and what kind of node it is there. */
  function nodesOf(a: Record<string, unknown>): Array<[string, NodeJson]> {
    const out: Array<[string, NodeJson]> = [];
    const coll = (k: string) => Object.values((a[k] ?? {}) as Record<string, NodeJson>);
    const name = (n: NodeJson) => String(n.definition?.name ?? "");
    const groupName = new Map(coll("groups").map((g) => [(g as { uuid: string }).uuid, name(g)]));
    const setName = new Map(coll("paramsetDefinitions").map((d) => [(d as { uuid: string }).uuid, name(d)]));
    for (const n of coll("analysisRoot")) out.push(["analysisRoot/root", n]);
    for (const n of coll("groups")) out.push([`groups/${["Acquired Data", "Compensation Data", "Experiment Data"].includes(name(n)) ? name(n) : "user"}`, n]);
    for (const n of coll("populationDefinitions")) {
      const d = n.definition ?? {};
      out.push([`populationDefinitions/${String(d.type)}:${String((d.gateDefinition as { type?: string } | undefined)?.type ?? "")}`, n]);
    }
    for (const n of coll("populations")) out.push(["populations/population", n]);
    for (const n of coll("compoundPopulations")) out.push(["compoundPopulations/population", n]);
    for (const n of coll("paramsetDefinitions")) out.push([`paramsetDefinitions/${name(n).replace(/ /g, "_")}`, n]);
    for (const n of coll("compoundParameterSets")) {
      const g = groupName.get(n.parents?.groups?.[0] ?? "") ?? "";
      const s = setName.get(n.parents?.paramsetDefinitions?.[0] ?? "") ?? "";
      out.push([`compoundParameterSets/${g.replace(/ /g, "_")}:${s.replace(/ /g, "_")}`, n]);
    }
    for (const n of coll("dataSources")) out.push(["dataSources/ds", n]);
    for (const n of coll("cytometers")) out.push(["cytometers/cytometer", n]);
    for (const n of coll("reports")) out.push(["reports/report", n]);
    for (const [type, group] of Object.entries((a.platforms ?? {}) as Record<string, Record<string, NodeJson>>)) {
      for (const n of Object.values(group)) out.push([`platforms/${type}:${String(n.definition?.model ?? "")}`, n]);
    }
    return out;
  }

  /** Per kind, the paths every node of that kind holds, with the types they take. */
  function required(analyses: Array<Record<string, unknown>>): Map<string, Map<string, Set<string>>> {
    const out = new Map<string, Map<string, Set<string>>>();
    for (const a of analyses) {
      for (const [kind, n] of nodesOf(a)) {
        const paths = new Map<string, Set<string>>();
        pathsOf(n, "", paths);
        const have = out.get(kind);
        if (!have) {
          out.set(kind, paths);
          continue;
        }
        for (const p of [...have.keys()]) {
          if (!paths.has(p)) have.delete(p);
          else for (const t of paths.get(p)!) have.get(p)!.add(t);
        }
      }
    }
    return out;
  }

  const readAnalysis = (bytes: Uint8Array): Record<string, unknown> => readFlowJo11Workbench(bytes).analysis;

  it.skipIf(!files.length)("are in a workbench GateLab writes, with the types FlowJo 11 gives them", () => {
    expect(files.length).toBeGreaterThanOrEqual(18);
    const theirs = required(files.map((f) => readAnalysis(new Uint8Array(readFileSync(join(dir, f))))));

    // A compensated file with a rectangle, a range, a polygon, an ellipse and a quadrant.
    const t = new Tree();
    const cells = t.pop("Cells", [{ gate: t.gate(newGate("Cells", "rectangle", "FSC-A", "SSC-A", [[20000, 20000], [200000, 20000], [200000, 200000], [20000, 200000]])) }]);
    t.pop("Poly", [{ gate: t.gate(newGate("Poly", "polygon", "FSC-A", "SSC-A", [[30000, 30000], [90000, 30000], [60000, 90000]])) }], cells);
    t.pop("Range", [{ gate: t.gate({ ...newGate("Range", "rectangle", "FL3-A", "FL3-A", [[100, 100], [5000, 100], [5000, 5000], [100, 5000]]) }) }], cells);
    const ell: EllipseGate = {
      gate_id: "e2", name: "E2", gate_type: "ellipse", x_channel: "FL1-A", y_channel: "FL2-A", mean: [60, 60],
      covariance: [[400, 150], [150, 225]], distance_square: 1, space: "display", transforms: { "FL1-A": BIEX, "FL2-A": BIEX }, color: "#000", label_offset: null,
    };
    t.pop("E2", [{ gate: t.gate(ell) }], cells);
    const q = t.gate({ ...newQuadrantGate("Q", "FL1-A", "FL2-A", [atBiex(100), atBiex(100)]), space: "raw" as const });
    for (const n of [1, 2, 3, 4]) t.pop(`Q${n}`, [{ gate: q, quadrant: n }], cells);
    const bytes = fcsBytes([{ "FSC-A": 50000, "SSC-A": 50000, "FL1-A": atBiex(150), "FL2-A": atBiex(50) }], true);
    const sample = openSample(bytes);
    sample.setCompensation(true);
    const ours = exportFlowJo11Workbench({ samples: [t.entry(sample, "D1.fcs")], fcsFolder: "/Users/D1/data", name: "synthetic" }).analysis;

    const gaps: string[] = [];
    for (const [kind, n] of nodesOf(ours)) {
      const want = theirs.get(kind);
      if (!want) continue;
      const have = new Map<string, Set<string>>();
      pathsOf(n, "", have);
      const prefixes = new Set([...have.keys()].flatMap((p) => [...p.matchAll(/\}/g)].map((m) => p.slice(0, m.index! + 1))));
      for (const [p, types] of want) {
        // An axis's fields are asked of an axis of the same type only.
        if ([...p.matchAll(/\}/g)].some((m) => !prefixes.has(p.slice(0, m.index! + 1)))) continue;
        const got = have.get(p);
        const why = !got ? "missing" : [...got].some((ty) => !types.has(ty)) ? `${[...got].join("/")} where FlowJo 11 writes ${[...types].join("/")}` : null;
        if (why && !TOLERATED.some(([re]) => re.test(`${kind} ${p}`))) gaps.push(`${kind} ${p}: ${why}`);
      }
    }
    expect(gaps).toEqual([]);
  });

  // FlowJo 11 refuses a workbench in which the populations or the data source hold results {}
  // (David's probes B1 and B2, round 8, 2026-10-23), and one with a group whose results lack the
  // list of its files (probe G1). The kinds checked are those FlowJo 11 never leaves empty in its
  // own workbenches; it does leave definitions, cytometers, the root and matrices empty.
  const FILLED = ["populations", "compoundPopulations", "compoundParameterSets", "groups", "dataSources", "reports", "platforms/statisticalModeling"];
  const resultsByKind = (a: Record<string, unknown>): Array<[string, unknown]> => {
    const out: Array<[string, unknown]> = [];
    for (const [k, v] of Object.entries(a)) {
      if (k === "platforms") {
        for (const [type, g] of Object.entries(v as Record<string, Record<string, NodeJson>>)) for (const n of Object.values(g)) out.push([`platforms/${type}`, n.results]);
      } else if (v && typeof v === "object" && !Array.isArray(v)) {
        for (const n of Object.values(v as Record<string, NodeJson>)) if (n && typeof n === "object" && "results" in n) out.push([k, n.results]);
      }
    }
    return out;
  };
  const isEmpty = (r: unknown) => !r || typeof r !== "object" || Object.keys(r).length === 0;

  it.skipIf(!files.length)("FlowJo 11 itself never leaves those results empty", () => {
    for (const f of files) {
      for (const [kind, r] of resultsByKind(readAnalysis(new Uint8Array(readFileSync(join(dir, f)))))) {
        if (FILLED.includes(kind)) expect(isEmpty(r), `${f} ${kind}`).toBe(false);
      }
    }
  });

  it("holds no empty results where FlowJo 11 refuses them, and every group lists its files", () => {
    // Two files, one of them gated with a NOT and a quadrant, one a compensation control in its own
    // group, so that every kind of population and an empty group are written.
    const t = new Tree();
    const cells = t.pop("Cells", [{ gate: t.gate(newGate("Cells", "rectangle", "FSC-A", "SSC-A", [[20000, 20000], [200000, 20000], [200000, 200000], [20000, 200000]])) }]);
    const poly = t.gate(newGate("Poly", "polygon", "FSC-A", "SSC-A", [[30000, 30000], [90000, 30000], [60000, 90000]]));
    t.pop("Poly", [{ gate: poly }], cells);
    t.pop("Not poly", [{ gate: poly, include: false }], cells);
    const q = t.gate({ ...newQuadrantGate("Q", "FL1-A", "FL2-A", [atBiex(100), atBiex(100)]), space: "raw" as const });
    for (const n of [1, 2, 3, 4]) t.pop(`Q${n}`, [{ gate: q, quadrant: n }], cells);
    const bytes = fcsBytes([{ "FSC-A": 50000, "SSC-A": 50000, "FL1-A": atBiex(150), "FL2-A": atBiex(50) }, { "FSC-A": 150000, "SSC-A": 150000 }], true);
    const entries = ["D1.fcs", "D1 unstained.fcs"].map((name) => {
      const s = openSample(bytes);
      s.setCompensation(true);
      return t.entry(s, name);
    });
    const ours = exportFlowJo11Workbench({ samples: entries, fcsFolder: "/Users/D1/data", name: "synthetic" }).analysis;

    const empty = resultsByKind(ours).filter(([kind, r]) => FILLED.includes(kind) && isEmpty(r)).map(([kind]) => kind);
    expect(empty).toEqual([]);
    const groups = Object.values(ours.groups as Record<string, NodeJson>);
    expect(groups).toHaveLength(3);
    for (const g of groups) expect(Array.isArray((g.results as { dataSources?: unknown }).dataSources)).toBe(true);
    // Each populations node holds its count.
    for (const p of Object.values(ours.populations as Record<string, NodeJson>)) expect(typeof (p.results as { count?: unknown }).count).toBe("number");
  });
});

describe("a biex range and rectangle on the private S6 files, against the counts FlowJo 11.2 saved", () => {
  // The S6 workbenches (FLOWJO11_WORKBENCH_DIR) hold a range on biex BV711-A under Singlets
  // and an uncompensated rectangle on biex APC-A × PE-A under Singlets; FlowJo 11.2 tests both with
  // each event on its 4096-entry table (flowjo11Workbench.ts, onTable). Each is counted on import and
  // again after GateLab's export is read back.
  const dir = FLOWJO11_WORKBENCH_DIR;
  const here = existsSync(join(dir, "fcs"));
  const FILES = ["sample_Bcell_check", "sample_Bmem_purity_large", "sample_Bmem_purity_small", "sample_PBMC_check"];
  const fcsOf = (f: string) => new Uint8Array(readFileSync(join(dir, "fcs", `${f}.fcs`)));
  const workbenchText = (wb: string) => flowJo11WorkbenchToWorkspace(readFlowJo11Workbench(new Uint8Array(readFileSync(join(dir, wb)))));
  const countOf = (tree: { gates: Record<string, Gate>; populations: PopulationMap; root_population_id: string }, sample: Sample, name: string) => {
    const { masks } = applyGatingStrategy(tree.gates, tree.populations, tree.root_population_id, sample.gateAssayData());
    const id = Object.keys(tree.populations).find((p) => tree.populations[p].name === name)!;
    return masks[id].reduce((a, b) => a + b, 0);
  };
  /** Export one file's tree and read it back onto the file, as the app opens a .flowjo. */
  const readBack = (entry: FlowJo11ExportSample, bytes: Uint8Array, uncompensated: boolean) => {
    const result = exportFlowJo11Workbench({ samples: [entry], fcsFolder: "/Users/D1/data", name: "s6", uuid: ids() });
    const text = flowJo11WorkbenchToWorkspace(readFlowJo11Workbench(result.bytes));
    if (!uncompensated) {
      const g = importGatingOnto(openSample(bytes), entry.fileName, text, "s6.flowjo");
      return { masks: memberships(g), tree: { gates: g.tree.gates, populations: g.tree.populations, root_population_id: g.tree.root_population_id }, sample: g.sample };
    }
    const sample = openSample(bytes);
    sample.setCompensation(false);
    const conv = flowJoWorkspaceToGatingML(text, 0, null, undefined, { flowJoGrid: true });
    const pnn: Record<string, string> = {};
    for (const c of sample.channels) pnn[c.pnn] = c.key;
    const res = importGatingML(conv.gatingMl, sample.channels.map((c) => c.key), pnn, sample.instrument);
    return { tree: res, sample };
  };

  it.skipIf(!here)("the range holds FlowJo 11's count on all four files, and its export holds it again", () => {
    const wb = "15-sample specific (PBMC check changed).flowjo";
    const text = workbenchText(wb);
    const counts = FILES.map((f) => {
      const g = importGatingOnto(openSample(fcsOf(f)), `${f}.fcs`, text, wb);
      const tree = { gates: g.tree.gates, populations: g.tree.populations, root_population_id: g.tree.root_population_id };
      const entry: FlowJo11ExportSample = { sample: g.sample, fileName: `${f}.fcs`, gates: tree.gates, gate_order: g.tree.gate_order, populations: tree.populations, root_population_id: tree.root_population_id };
      const back = readBack(entry, fcsOf(f), false);
      return [g.flowJoCounts?.["BV7110 range"], countOf(tree, g.sample, "BV7110 range"), countOf(back.tree, back.sample, "BV7110 range")];
    });
    expect(counts).toEqual([[6756, 6756, 6756], [2191, 2191, 2191], [0, 0, 0], [617, 617, 617]]);
  });

  it.skipIf(!here)("the uncompensated rectangle holds FlowJo 11's eight saved counts, and its export holds them again", () => {
    // GateLab refuses a gate on uncompensated values among compensated ones (gatingml.ts), so the
    // rectangle is counted with every gate of the file read uncompensated: Singlets, on scatter, is
    // unchanged by it, and the rectangle is evaluated as FlowJo 11 drew it.
    const cases: Array<[string, string, number]> = [
      ...FILES.map((f, i): [string, string, number] => ["15-sample specific (PBMC check changed).flowjo", f, [2871, 12222, 807, 3729][i]]),
      ["04-rectangle.flowjo", "sample_PBMC_check", 4793],
      ["With ellipse gate.flowjo", "sample_PBMC_check", 3729],
      ["Edited comp matrix.flowjo", "sample_PBMC_check", 3729],
      ["14-all samples.flowjo", "sample_Bcell_check", 2871],
    ];
    const got = cases.map(([wb, f]) => {
      const text = workbenchText(wb);
      const index = listFlowJoWorkspaceSamples(text).find((s) => s.name === `${f}.fcs`)!.index;
      const conv = flowJoWorkspaceToGatingML(text, index, null, undefined, { flowJoGrid: true });
      const sample = openSample(fcsOf(f));
      sample.setCompensation(false);
      const pnn: Record<string, string> = {};
      for (const c of sample.channels) pnn[c.pnn] = c.key;
      const gml = conv.gatingMl.replace(/compensation-ref="[^"]*"/g, 'compensation-ref="uncompensated"');
      const res = importGatingML(gml, sample.channels.map((c) => c.key), pnn, sample.instrument);
      const entry: FlowJo11ExportSample = { sample, fileName: `${f}.fcs`, gates: res.gates, gate_order: res.gate_order, populations: res.populations, root_population_id: res.root_population_id };
      const back = readBack(entry, fcsOf(f), true);
      return [conv.flowJoCounts?.Rectangle, countOf(res, sample, "Rectangle"), countOf(back.tree, back.sample, "Rectangle")];
    });
    expect(got).toEqual(cases.map(([, , n]) => [n, n, n]));
  });
});
