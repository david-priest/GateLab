// @vitest-environment jsdom
//
// Straight quadrants in Gating-ML export: a region whose divider the format cannot write between
// the events either side of it is left out with what uses it and named, never written so that it
// moves events, and never allowed to refuse the whole export. FlowKit's reading of the same cases
// is in tools/interop/lib/gmlStraightQuadrants.test.mjs.
import { describe, it, expect } from "vitest";
import { exportGatingML, type GatingMLFormat } from "./gatingmlExport";
import { importGatingML } from "./gatingml";
import { applyGatingStrategy } from "./populations";
import { Sample, transformFromSpec } from "./sample";
import type { FcsFile } from "./fcs";
import {
  linkChildToParent, newGateRef, newPopulation, newRootPopulation,
  type Gate, type PopulationMap, type TransformSpec,
} from "./models";

function sampleOf(xs: number[], ys: number[], float32: boolean): Sample {
  const column = (v: number[]) => (float32 ? Float32Array.from(v) : Float64Array.from(v));
  const fcs: FcsFile = {
    version: "FCS3.1", nEvents: xs.length, instrument: "flow", keywords: {}, spillover: null,
    channels: ["FL1-A", "FL2-A"].map((name, index) => ({ index, name, marker: null, bits: float32 ? 32 : 64, range: 262144 })),
    columns: [column(xs), column(ys)],
  };
  return new Sample(fcs);
}

/** A quadrant gate, a population per quadrant, and a rectangle population beside them. */
function treeOf(center: [number, number], transform: TransformSpec | null) {
  const quadrant: Gate = {
    gate_id: "q", name: "CD4_CD8", gate_type: "quadrant", x_channel: "FL1-A", y_channel: "FL2-A", center,
    color: "#000", label_offset: null,
    ...(transform ? { space: "display" as const, transforms: { "FL1-A": transform, "FL2-A": transform } } : { space: "raw" as const }),
  };
  const control: Gate = {
    gate_id: "c", name: "control", gate_type: "rectangle", x_channel: "FL1-A", y_channel: "FL2-A", space: "raw",
    vertices: [[-1e9, -1e9], [1e9, 1e9]], color: "#000", label_offset: null,
  };
  const root = newRootPopulation();
  const populations: PopulationMap = { [root.population_id]: root };
  const add = (name: string, refs: ReturnType<typeof newGateRef>[], parent = root.population_id) => {
    const pop = newPopulation(name, refs, parent);
    populations[pop.population_id] = pop;
    linkChildToParent(populations, pop.population_id, parent);
    return pop.population_id;
  };
  for (const q of [1, 2, 3, 4]) add(`Q${q}`, [newGateRef("q", true, q)]);
  const controlId = add("control", [newGateRef("c")]);
  add("not Q1", [newGateRef("q", false, 1)], controlId);
  return { gates: { q: quadrant, c: control }, gate_order: ["q", "c"], populations, root_population_id: root.population_id };
}

/** The file's populations as GateLab imports and evaluates them, by name. */
function readBack(xml: string, sample: Sample): Map<string, number[]> {
  const res = importGatingML(xml, sample.channels.map((c) => c.key), Object.fromEntries(sample.channels.map((c) => [c.pnn, c.key])));
  const { masks } = applyGatingStrategy(res.gates, res.populations, res.root_population_id, sample.gateAssayData());
  return new Map(Object.values(res.populations).map((p) => [p.name, Array.from(masks[p.population_id] ?? [])]));
}

describe("straight quadrant regions the format cannot write", () => {
  it("writes a FlowJo log quadrant's Cytobank cut in raw values where its flog values share one float32", () => {
    // FlowJo log is written as flog one decade up, where float32 steps are twice as coarse as in
    // GateLab's own column: two adjacent float32 events either side of the divider become one
    // flog float32, as GateLab reads a flog dimension back, and no flog cut separates them.
    const wsplog: TransformSpec = { kind: "wsplog", offset: 1, decades: 5.418539922 };
    const own = (v: number) => Math.fround((1 / 5.418539922) * Math.log10(Math.max(v, 1)));
    const flog = (v: number) => Math.fround(Math.log10(Math.max(v, 1)) / 5.418539922 + 1);
    const f = new Float32Array([1000]);
    const bits = new Int32Array(f.buffer);
    let left = 0, right = 0;
    for (;;) {
      left = f[0];
      bits[0] += 1;
      right = f[0];
      if (own(left) < own(right) && flog(left) === flog(right)) break;
    }
    const divider = (own(left) + own(right)) / 2;
    const xs = [left, right, left, right, 1e5, 1e5, 10, 10];
    const ys = [1e5, 1e5, 10, 10, left, right, left, right];
    const owners = [1, 2, 4, 3, 3, 2, 4, 1];
    const sample = sampleOf(xs, ys, true);
    const warnings: string[] = [];
    const xml = exportGatingML({ ...treeOf([divider, divider], wsplog), sample, format: "cytobank", allowQuadrantOmission: true, warnings });
    expect(warnings).toEqual([]);
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const region = (q: number) => [...doc.getElementsByTagName("gating:PolygonGate")]
      .find((el) => el.getElementsByTagName("name")[0]?.textContent === `CD4_CD8 Q${q}`);
    // Q2's divider on x and y is on flog's side of both axes, so both are cut in raw values.
    const dims = [...region(2)!.getElementsByTagName("gating:dimension")];
    expect(dims.map((d) => d.getAttribute("gating:transformation-ref"))).toEqual([null, null]);
    const back = readBack(xml, sample);
    for (const q of [1, 2, 3, 4]) expect(back.get(`Q${q}`), `Q${q}`).toEqual(owners.map((o) => Number(o === q)));
    expect(back.get("not Q1")).toEqual(owners.map((o) => Number(o !== 1)));
  });

  // A divider at 2 with an event one double below it: no bound of a standard file holds that event
  // below the divider and is also clear of the event at 2 for a reader of the other edge rule, and
  // no cut lies strictly between the two for Cytobank's polygons.
  const adjacent = () => sampleOf([2 - Number.EPSILON, 2, 2 - Number.EPSILON, 2], [3, 3, 1, 1], false);
  const omitted: Record<GatingMLFormat, number[]> = { standard: [1, 4], cytobank: [1, 2, 3, 4] };

  it.each(["standard", "cytobank"] as const)("leaves such a region out of the %s format, with what uses it, and names it", (format) => {
    const sample = adjacent();
    const tree = treeOf([2, 2], null);
    expect(() => exportGatingML({ ...tree, sample, format })).toThrow(/"CD4_CD8 Q1" cannot be written .* explicitly accepting its omission/);
    const warnings: string[] = [];
    const xml = exportGatingML({ ...tree, sample, format, allowQuadrantOmission: true, warnings });
    const names = omitted[format].map((q) => `"CD4_CD8 Q${q}"`).join(", ");
    expect(warnings).toEqual([expect.stringContaining(`quadrant regions ${names} were left out`)]);
    const back = readBack(xml, sample);
    // Every region written holds exactly GateLab's events; the rest, and what uses them, are absent.
    const want = [1, 2, 4, 3];
    for (const q of [1, 2, 3, 4]) {
      if (omitted[format].includes(q)) expect(back.has(`Q${q}`), `Q${q} left out`).toBe(false);
      else expect(back.get(`Q${q}`), `Q${q}`).toEqual(want.map((o) => Number(o === q)));
    }
    expect(back.has("not Q1")).toBe(false);
    expect(back.get("control")).toEqual([1, 1, 1, 1]);
  });
});

describe("a straight quadrant gate comes back from GateLab's own Gating-ML as one gate (David, 2026-11-10)", () => {
  // Events on each side of the centre (3, 3), two on its lines; owners are the quadrants they are in.
  const xs = [1, 5, 5, 1, 3, 1, 3, 1e30];
  const ys = [5, 5, 1, 1, 3, 3, 1, 1e30];
  const owners = [1, 2, 3, 4, 2, 1, 3, 2];
  const imported = (xml: string, sample: Sample) =>
    importGatingML(xml, sample.channels.map((c) => c.key), Object.fromEntries(sample.channels.map((c) => [c.pnn, c.key])));

  it.each([
    ["in raw values", null],
    ["on a logicle display", { kind: "logicle", T: 262144, W: 0.5, M: 4.5, A: 0 } as TransformSpec],
  ])("%s: one quadrant gate, its populations on its quadrants, every event where it was", (_label, transform) => {
    const sample = sampleOf(xs, ys, true);
    // On the logicle display the centre is raw 3 carried there, so the same events lie on each side.
    const at3 = transform ? transformFromSpec(transform).forward(3) : 3;
    const tree = treeOf([at3, at3], transform);
    const xml = exportGatingML({ ...tree, sample, format: "standard" });
    // Another reader sees the four rectangles.
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    expect(doc.getElementsByTagName("gating:RectangleGate").length).toBe(5);
    const res = imported(xml, sample);
    const quadrants = Object.values(res.gates).filter((g) => g.gate_type === "quadrant");
    expect(quadrants).toHaveLength(1);
    const q = quadrants[0];
    expect(q.name).toBe("CD4_CD8");
    expect(q.gate_type === "quadrant" && q.center).toEqual(tree.gates.q.gate_type === "quadrant" ? tree.gates.q.center : null);
    expect(q.space ?? "raw").toBe(tree.gates.q.space ?? "raw");
    expect(Object.values(res.gates).map((g) => g.name).sort()).toEqual(["CD4_CD8", "control"]);
    expect(res.gate_order).toEqual([q.gate_id, Object.values(res.gates).find((g) => g.name === "control")!.gate_id]);
    const byName = Object.fromEntries(Object.values(res.populations).map((p) => [p.name, p]));
    for (const n of [1, 2, 3, 4]) expect(byName[`Q${n}`].gate_refs).toEqual([{ gate_id: q.gate_id, include: true, quadrant: n }]);
    expect(byName["not Q1"].gate_refs).toEqual([{ gate_id: q.gate_id, include: false, quadrant: 1 }]);
    // Drawn and counted: each population holds what GateLab's own quadrant held, and on raw axes
    // that is the hand-placed owners (the 1e30 event is outside "control", "not Q1"'s parent).
    const back = readBack(xml, sample);
    const { masks } = applyGatingStrategy(tree.gates, tree.populations, tree.root_population_id, sample.gateAssayData());
    for (const pop of Object.values(tree.populations)) expect(back.get(pop.name), pop.name).toEqual(Array.from(masks[pop.population_id]));
    if (!transform) {
      for (const n of [1, 2, 3, 4]) expect(back.get(`Q${n}`), `Q${n}`).toEqual(owners.map((o) => Number(o === n)));
      expect(back.get("not Q1")).toEqual(owners.map((o, i) => Number(o !== 1 && i !== 7)));
    } else {
      // Every quadrant holds some event on the logicle display too.
      for (const n of [1, 2, 3, 4]) expect(back.get(`Q${n}`)!.some(Boolean), `Q${n}`).toBe(true);
    }
  });

  it("keeps the rectangles of a file edited elsewhere so that they no longer meet at one centre", () => {
    const sample = sampleOf(xs, ys, true);
    const xml = exportGatingML({ ...treeOf([3, 3], null), sample, format: "standard" });
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const q2 = [...doc.getElementsByTagName("gating:RectangleGate")].find((el) => el.getElementsByTagName("name")[0]?.textContent === "CD4_CD8 Q2")!;
    const dim = q2.getElementsByTagName("gating:dimension")[0];
    dim.setAttribute("gating:min", "4");
    const edited = new XMLSerializer().serializeToString(doc);
    const res = imported(edited, sample);
    expect(Object.values(res.gates).some((g) => g.gate_type === "quadrant")).toBe(false);
    expect(Object.values(res.gates).filter((g) => /CD4_CD8 Q\d/.test(g.name))).toHaveLength(4);
  });

  it("writes no record in the Cytobank format, whose regions are polygons", () => {
    const sample = sampleOf(xs, ys, true);
    const xml = exportGatingML({ ...treeOf([3, 3], null), sample, format: "cytobank" });
    expect(xml).not.toContain("gatelab_quadrants");
  });
});
