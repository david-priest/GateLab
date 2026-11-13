// @vitest-environment jsdom
// The .cef export: a quadrant reference with no number or an impossible one, the order of gates,
// a sort destination cleared with its population, the layout of written objects, and how closely a
// traced display polygon follows its edges.
import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { chorusAxisSpec, chorusDisplayFromKeywords, chorusToGatingML, readChorusExperiment } from "./chorusExperiment";
import { exportChorusExperiment, formatChorusJson, type ChorusExportChannel } from "./chorusExport";
import { importGatingML } from "./gatingml";
import { transformFromSpec } from "./sample";
import type { Gate, PolyRectGate, PopulationMap } from "./models";

const CHANNELS = ["Time", "FSC-A", "SSC-A", "PE-A", "BV711-A"];
const channels: ChorusExportChannel[] = CHANNELS.map((c) => ({ key: c, pnn: c }));
const kw: Record<string, string> = { $PAR: String(CHANNELS.length) };
CHANNELS.forEach((name, i) => { kw[`$P${i + 1}N`] = name; kw[`$P${i + 1}R`] = "262144"; });

const sp = (name: string) => ({ measurementId: name.replace(/-A$/, ""), fluorochrome: name.split("-")[0], measurement: "A", scatter: name, scale: "Linear", numerator: null, denominator: null, parameterKind: "Scatter" });
const jgate = (id: string, name: string, parent = "0-1") => ({
  children: [{ name, color: "0,0,255", populationId: `${id}-1` }], inputPopulationIds: null, parameters: [sp("FSC-A"), sp("SSC-A")],
  vertices: [{ x: 1, y: 1 }, { x: 9, y: 1 }, { x: 9, y: 9 }], gateKind: "Polygon", name, gateId: id, parentPopulationId: parent, categories: [],
});
function cefOf(gates: unknown[], panelExtra: Record<string, unknown> = {}): Uint8Array {
  const doc = { experiment: { panels: [{ name: "Panel 1", analysis: { gates, analysisWorksheets: [] }, ...panelExtra }] }, sortRecords: [], fluorochromes: [] };
  return zipSync({
    "manifest.json": strToU8(JSON.stringify({ version: "1.0.0", chorusVersion: "5.4.0", experimentName: "synthetic" })),
    "experiment.json": strToU8(JSON.stringify(doc, null, 2)),
    "instrument.json": strToU8("{}"),
    verification: strToU8("0000"),
  });
}
const treeOf = (source: Uint8Array, k = kw) => importGatingML(chorusToGatingML(readChorusExperiment(source), 0, { keywords: k }).gatingMl, CHANNELS, {}, "flow");
type JGate = { gateId: string; name: string; children: { name: string }[]; vertices: { x: number; y: number }[] };
const gatesOf = (bytes: Uint8Array): JGate[] => JSON.parse(strFromU8(unzipSync(bytes)["experiment.json"])).experiment.panels[0].analysis.gates;

describe("quadrant references", () => {
  const withQuadrant = (quadrant: number | undefined) => {
    const source = cefOf([jgate("1", "D1")]);
    const tree = treeOf(source);
    const root = tree.populations[tree.root_population_id];
    const q = { gate_id: "q", name: "Q", gate_type: "quadrant", x_channel: "FSC-A", y_channel: "SSC-A", center: [100, 50], color: "#000000", label_offset: null } as unknown as Gate;
    const populations: PopulationMap = { ...tree.populations, qp: { population_id: "qp", name: "S1", gate_refs: [{ gate_id: "q", include: true, ...(quadrant !== undefined ? { quadrant } : {}) }], gate_logic: "and", parent_id: root.population_id, children: [], event_count: null, percent_of_parent: null } };
    populations[root.population_id] = { ...root, children: [...root.children, "qp"] };
    return exportChorusExperiment({ source, channels, keywords: kw, gates: { ...tree.gates, q }, populations, root_population_id: tree.root_population_id });
  };

  it("writes a reference that names no quadrant as Q1, as the mask reads it", () => {
    const g = gatesOf(withQuadrant(undefined).bytes).find((x) => x.children[0].name === "S1")!;
    expect(g.name).toBe("Q Q1");
    expect(g.vertices).toEqual([{ x: 0, y: 50 }, { x: 100, y: 50 }, { x: 100, y: 262144 }, { x: 0, y: 262144 }]);
  });

  it("leaves out a reference to a quadrant that does not exist, and says so", () => {
    const r = withQuadrant(5);
    expect(r.skipped).toEqual([{ name: "S1", why: "its gate has fewer than three vertices" }]);
  });
});

describe("the gates array", () => {
  it("keeps the source's gate order for an unchanged tree", () => {
    const source = cefOf([jgate("3", "D3"), jgate("1", "D1"), jgate("2", "D2")]);
    const tree = treeOf(source);
    const r = exportChorusExperiment({ source, channels, keywords: kw, gates: tree.gates, populations: tree.populations, root_population_id: tree.root_population_id });
    expect(gatesOf(r.bytes).map((g) => g.gateId)).toEqual(["3", "1", "2"]);
  });

  it("puts a new gate after the source's gates, whatever its place in the tree", () => {
    const source = cefOf([jgate("3", "D3"), jgate("1", "D1"), jgate("2", "D2")]);
    const tree = treeOf(source);
    const root = tree.populations[tree.root_population_id];
    const gate: PolyRectGate = { gate_id: "n", name: "S1", gate_type: "rectangle", x_channel: "FSC-A", y_channel: "SSC-A", vertices: [[1, 1], [5, 5]], color: "#000000", label_offset: null };
    const populations: PopulationMap = { ...tree.populations, np: { population_id: "np", name: "S1", gate_refs: [{ gate_id: "n", include: true }], gate_logic: "and", parent_id: root.population_id, children: [], event_count: null, percent_of_parent: null } };
    populations[root.population_id] = { ...root, children: ["np", ...root.children] };
    const r = exportChorusExperiment({ source, channels, keywords: kw, gates: { ...tree.gates, n: gate }, populations, root_population_id: tree.root_population_id });
    expect(gatesOf(r.bytes).map((g) => g.gateId)).toEqual(["3", "1", "2", "4"]);
  });

  it("clears a sort destination assigned to a population no longer present, naming it, and leaves the rest", () => {
    const source = cefOf([jgate("1", "D1"), jgate("2", "D2")], { sortMappings: [{ assignedPopulations: ["1-1", "2-1"] }, { assignedPopulations: ["1-1"] }] });
    const tree = treeOf(source);
    const d2 = Object.values(tree.populations).find((p) => p.name === "D2")!;
    const root = tree.populations[tree.root_population_id];
    const populations = { ...tree.populations, [root.population_id]: { ...root, children: root.children.filter((c) => c !== d2.population_id) } };
    const r = exportChorusExperiment({ source, channels, keywords: kw, gates: tree.gates, populations, root_population_id: tree.root_population_id });
    const doc = JSON.parse(strFromU8(unzipSync(r.bytes)["experiment.json"]));
    expect(doc.experiment.panels[0].sortMappings.map((m: { assignedPopulations: string[] }) => m.assignedPopulations)).toEqual([["1-1"], ["1-1"]]);
    expect(r.warnings.filter((w) => /sort destination/.test(w))).toEqual([
      'A sort destination was assigned to "D2", which the tree no longer holds; the assignment is cleared.',
    ]);
  });
});

describe("formatChorusJson", () => {
  it("indents an object's keys one level deeper than its braces", () => {
    const style = { pretty: { eol: "\n", unit: "  ", base: "" } };
    expect(formatChorusJson({ a: 1, b: [2] }, style, new Set())).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
  });
});

describe("a traced display-space polygon", () => {
  it("lies within 1e-5 of its extent, per axis, of the edge in Chorus's display", () => {
    const k: Record<string, string> = { ...kw, P4M: "7", P4MS: "42898", P5M: "7", P5MS: "21475" };
    const source = cefOf([jgate("1", "D1")]);
    const tree = treeOf(source, k);
    const logicle = { kind: "logicle" as const, T: 262144, W: 0.5, M: 4.5, A: 0 };
    const t = transformFromSpec(logicle);
    // Narrow on x, tall on y, with one long sloping edge that bends in Chorus's display.
    const corners: [number, number][] = [[-200, -200], [3000, -200], [-200, 150000]];
    const gate: PolyRectGate = {
      gate_id: "drawn", name: "S2", gate_type: "polygon", x_channel: "PE-A", y_channel: "BV711-A", space: "display",
      vertices: corners.map(([x, y]) => [t.forward(x), t.forward(y)] as [number, number]), transforms: { "PE-A": logicle, "BV711-A": logicle }, color: "#000000", label_offset: null,
    };
    const root = tree.populations[tree.root_population_id];
    const populations: PopulationMap = { ...tree.populations, sp2: { population_id: "sp2", name: "S2", gate_refs: [{ gate_id: "drawn", include: true }], gate_logic: "and", parent_id: root.population_id, children: [], event_count: null, percent_of_parent: null } };
    populations[root.population_id] = { ...root, children: [...root.children, "sp2"] };
    const r = exportChorusExperiment({ source, channels, keywords: k, gates: { ...tree.gates, drawn: gate }, populations, root_population_id: tree.root_population_id });
    const written = gatesOf(r.bytes).find((g) => g.children[0].name === "S2")!.vertices;

    const display = chorusDisplayFromKeywords(k)!;
    const cx = transformFromSpec(chorusAxisSpec(display.get("PE-A")!)!).forward;
    const cy = transformFromSpec(chorusAxisSpec(display.get("BV711-A")!)!).forward;
    const ring = written.map((v) => [cx(v.x), cy(v.y)] as [number, number]);
    const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
    const sx = Math.max(...xs) - Math.min(...xs), sy = Math.max(...ys) - Math.min(...ys);
    const dist = (p: [number, number], a: [number, number], b: [number, number]) => {
      const [px, py, ax, ay, bx, by] = [p[0] / sx, p[1] / sy, a[0] / sx, a[1] / sy, b[0] / sx, b[1] / sy];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const u = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
      return Math.hypot(px - ax - u * dx, py - ay - u * dy);
    };
    let worst = 0;
    const v = gate.vertices;
    for (let e = 0; e < v.length; e++) {
      const a = v[e], b = v[(e + 1) % v.length];
      for (let s = 0; s <= 4000; s++) {
        const f = s / 4000;
        const p: [number, number] = [cx(t.inverse(a[0] + (b[0] - a[0]) * f)), cy(t.inverse(a[1] + (b[1] - a[1]) * f))];
        let best = Infinity;
        for (let i = 0; i < ring.length; i++) best = Math.min(best, dist(p, ring[i], ring[(i + 1) % ring.length]));
        worst = Math.max(worst, best);
      }
    }
    // The trace checks three points a piece, so allow a little over its 1e-5.
    expect(worst).toBeLessThan(3e-5);
  });
});
