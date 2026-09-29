// @vitest-environment jsdom
//
// The FlowJo workspace round trip: export the workspace as a .wsp, read it back with the FlowJo
// importer (the one that reads real FlowJo files), and the same engine must assign the same
// events. Exact for rectangles, for quadrants, for gates straight in the axis the file declares
// (mass cytometry on fasinh, FlowJo's own biex gates going home) and for the Boolean nodes built
// on them; within the densification bound for a polygon whose own space is not the declared one.
//
// FACSChorus, the reader this export exists for, is not on this machine. What is asserted here
// is that the file says what GateLab means, in the vocabulary FlowJo writes.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseFcs } from "./fcs";
import { Sample } from "./sample";
import { exportFlowJoWorkspace, planFlowJoExport, type FlowJoExportSample } from "./flowjoExport";
import { flowJoWorkspaceToGatingML, listFlowJoWorkspaceSamples, type FlowJoImportOptions } from "./flowjoWorkspace";
import { isFlowJoGridGate } from "./flowjoGrid";
import { importGatingML, resolveGatingMLCompensation } from "./gatingml";
import { exportGatingML } from "./gatingmlExport";
import { applyGatingStrategy } from "./populations";
import {
  linkChildToParent, newGate, newGateRef, newPopulation, newQuadrantGate, newRootPopulation,
  flowJoCurlForDisplay, type Gate, type PopulationMap, type Vertex,
} from "./models";
import { ARIA_SMALL, FIXTURES_ROOT, S6_FCS, S6_WORKSPACE, VENDOR_MATRIX_DIR, Z2DR_WORKSPACE } from "../testFixtures";
import { biexTransform, FLOWJO_BIEX_TABLE_CHANNELS } from "./biex";
import { writeFcs } from "./fcsExport";

const CYTOF_FILE = `${FIXTURES_ROOT}/PUBLIC - Screenshot Safe/Bodenmiller BCR-XL CyTOF benchmark/source-fcs/PBMC8_30min_patient1_BCR-XL.fcs`;

function load(path: string): Sample {
  const b = readFileSync(path);
  return new Sample(parseFcs(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer));
}

/** A quantile of a channel's raw values, from a sample of the column. */
function quantile(sample: Sample, key: string, p: number): number {
  const idx = sample.index(key)!;
  const raw = sample.rawColumnData(idx);
  const step = Math.max(1, Math.floor(raw.length / 20000));
  const vals: number[] = [];
  for (let i = 0; i < raw.length; i += step) if (Number.isFinite(raw[i])) vals.push(raw[i]);
  vals.sort((a, b) => a - b);
  return vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
}

/** A pentagon spanning the middle of the data on two channels, in raw values. */
function pentagon(sample: Sample, x: string, y: string): Vertex[] {
  const [x1, x2] = [quantile(sample, x, 0.2), quantile(sample, x, 0.8)];
  const [y1, y2] = [quantile(sample, y, 0.2), quantile(sample, y, 0.8)];
  const mx = (x1 + x2) / 2;
  return [[x1, y1], [x2, y1 + (y2 - y1) * 0.15], [x2, y2], [mx, y2 + (y2 - y1) * 0.2], [x1, y2 - (y2 - y1) * 0.1]];
}

interface Tree {
  gates: Record<string, Gate>;
  gate_order: string[];
  populations: PopulationMap;
  root_population_id: string;
}

class TreeBuilder {
  gates: Record<string, Gate> = {};
  gate_order: string[] = [];
  populations: PopulationMap;
  root: string;
  constructor() {
    const root = newRootPopulation();
    this.populations = { [root.population_id]: root };
    this.root = root.population_id;
  }
  gate(g: Gate): Gate {
    this.gates[g.gate_id] = g;
    this.gate_order.push(g.gate_id);
    return g;
  }
  pop(name: string, refs: { gate: Gate; include?: boolean; quadrant?: number }[], parent: string, logic: "and" | "or" = "and"): string {
    const p = newPopulation(name, refs.map((r) => newGateRef(r.gate.gate_id, r.include ?? true, r.quadrant)), parent, logic);
    this.populations[p.population_id] = p;
    this.populations = linkChildToParent(this.populations, p.population_id, parent);
    return p.population_id;
  }
  tree(): Tree {
    return { gates: this.gates, gate_order: this.gate_order, populations: this.populations, root_population_id: this.root };
  }
}


/** The biex a workspace declares for one parameter, by its $PnN. */
function declaredBiex(xml: string, pnn: string): { maxRange: number; width: number } | null {
  const re = new RegExp(`<transforms:biex ([^>]*)>\\s*<data-type:parameter[^>]*data-type:name="${pnn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`);
  const m = xml.match(re);
  if (!m) return null;
  const attr = (name: string) => Number(m[1].match(new RegExp(`transforms:${name}="([^"]+)"`))![1]);
  return { maxRange: attr("maxRange"), width: attr("width") };
}

/** A polygon gate's vertices as written, by the population's name. */
function writtenPolygon(xml: string, name: string): Vertex[] | null {
  const re = new RegExp(`<Population name="${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>[\\s\\S]*?<gating:PolygonGate[\\s\\S]*?</gating:PolygonGate>`);
  const m = xml.match(re);
  if (!m) return null;
  const v = [...m[0].matchAll(/data-type:value="([^"]+)"/g)].map((x) => Number(x[1]));
  const out: Vertex[] = [];
  for (let i = 0; i + 1 < v.length; i += 2) out.push([v[i], v[i + 1]]);
  return out;
}

/**
 * A FlowJo workspace's one gated sample, imported the way the application imports it. Evaluated
 * continuously unless asked: these tests are about the geometry the file carries, and on FlowJo's
 * grid (flowjoGrid.ts) a gate GateLab drew is quantised on its way back in, as FlowJo quantises it.
 */
function importWorkspace(text: string, sample: Sample, index = 0, options: FlowJoImportOptions = { flowJoGrid: false }): Tree {
  const conv = flowJoWorkspaceToGatingML(text, index, null, undefined, options);
  const pnn: Record<string, string> = {};
  for (const c of sample.channels) pnn[c.pnn] = c.key;
  const res = importGatingML(conv.gatingMl, sample.channels.map((c) => c.key), pnn, sample.instrument);
  const external = conv.spillover && sample.instrument === "flow" ? sample.externalSpilloverPreview(conv.spillover.matrix) : null;
  const comp = resolveGatingMLCompensation(res.compensation, res.compensation_refs, sample.instrument === "flow", external?.display ?? sample.spillover ?? null);
  if (comp.target === true && conv.spillover && external?.display != null) {
    sample.installExternalSpillover(conv.spillover.matrix, conv.spillover.name || "the workspace", { replaceEmbedded: sample.spillover !== null });
  }
  if (comp.target !== null) sample.setCompensation(comp.target);
  return { gates: res.gates, gate_order: Object.keys(res.gates), populations: res.populations, root_population_id: res.root_population_id };
}

/** Every gate of a tree held in raw space: what a workspace saved before gates carried a space holds. */
function inRawSpace(sample: Sample, tree: Tree): Tree {
  const gates: Record<string, Gate> = {};
  for (const [id, g] of Object.entries(tree.gates)) {
    if (g.gate_type === "polygon" || g.gate_type === "rectangle") {
      const vertices: Vertex[] = g.vertices.map((v) => [sample.gateToRaw(g, g.x_channel, v[0]), sample.gateToRaw(g, g.y_channel, v[1])]);
      const { space: _s, transforms: _t, ...rest } = g;
      void _s; void _t;
      gates[id] = { ...rest, vertices, space: "raw" } as Gate;
    } else {
      gates[id] = g;
    }
  }
  return { ...tree, gates };
}

/**
 * Masks per population name, from the engine. A name is also entered under its parent-qualified
 * form ("parent/name"), because the FlowJo importer qualifies a leaf name that recurs under
 * different parents — which helper populations named after their gate do.
 */
function evaluate(sample: Sample, tree: Tree): Map<string, Uint8Array> {
  const { masks } = applyGatingStrategy(tree.gates, tree.populations, tree.root_population_id, sample.gateAssayData());
  const out = new Map<string, Uint8Array>();
  for (const [pid, pop] of Object.entries(tree.populations)) {
    if (pid === tree.root_population_id) continue;
    if (!out.has(pop.name)) out.set(pop.name, masks[pid]);
    const parent = pop.parent_id ? tree.populations[pop.parent_id] : null;
    if (parent && pop.parent_id !== tree.root_population_id) out.set(`${parent.name.split("/").pop()}/${pop.name}`, masks[pid]);
  }
  return out;
}

/** The imported mask for an original population: by its name, else by its qualified name. */
function lookup(after: Map<string, Uint8Array>, tree: Tree, name: string): Uint8Array | undefined {
  if (after.has(name)) return after.get(name);
  const pop = Object.values(tree.populations).find((p) => p.name === name);
  const parent = pop?.parent_id ? tree.populations[pop.parent_id] : null;
  return parent ? after.get(`${parent.name}/${name}`) : undefined;
}

function moved(a: Uint8Array, b: Uint8Array): number {
  expect(b.length).toBe(a.length);
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

const count = (m: Uint8Array): number => m.reduce((s, v) => s + v, 0);

/**
 * Export → the FlowJo importer → the engine, on a FRESH Sample so nothing of the original's state
 * leaks in. The importer qualifies a repeated name with its parent; every name here is unique.
 */
function roundTrip(
  entry: FlowJoExportSample, fresh: Sample, options: FlowJoImportOptions = { flowJoGrid: false },
): { masks: Map<string, Uint8Array>; xml: string; warnings: string[]; conv: ReturnType<typeof flowJoWorkspaceToGatingML> } {
  const { xml, warnings } = exportFlowJoWorkspace({ samples: [entry], now: new Date("2026-09-14T00:00:00Z"), producer: "GateLab test" });
  const summaries = listFlowJoWorkspaceSamples(xml);
  expect(summaries).toHaveLength(1);
  expect(summaries[0].candidateFileNames).toContain(entry.fileName);
  const conv = flowJoWorkspaceToGatingML(xml, 0, null, undefined, options);
  const pnn: Record<string, string> = {};
  for (const c of fresh.channels) pnn[c.pnn] = c.key;
  const res = importGatingML(conv.gatingMl, fresh.channels.map((c) => c.key), pnn, fresh.instrument);
  // Compensate as the application does on import: the workspace's matrix over the file's own.
  const external = conv.spillover && fresh.instrument === "flow" ? fresh.externalSpilloverPreview(conv.spillover.matrix) : null;
  const comp = resolveGatingMLCompensation(res.compensation, res.compensation_refs, fresh.instrument === "flow", external?.display ?? fresh.spillover ?? null);
  if (comp.target === true && conv.spillover && external?.display != null) {
    fresh.installExternalSpillover(conv.spillover.matrix, conv.spillover.name || "the workspace", { replaceEmbedded: fresh.spillover !== null });
  }
  if (comp.target !== null) fresh.setCompensation(comp.target);
  const masks = evaluate(fresh, { gates: res.gates, gate_order: Object.keys(res.gates), populations: res.populations, root_population_id: res.root_population_id });
  return { masks, xml, warnings, conv };
}

describe.runIf(existsSync(ARIA_SMALL))("FlowJo workspace export, conventional flow", () => {
  const sample = load(ARIA_SMALL);
  const scatter = sample.channels.filter((_, i) => sample.isScatterAxis(i)).map((c) => c.key);
  const fluor = sample.channels.filter((_, i) => sample.isFluorChannel(i)).map((c) => c.key);
  const [fscA, sscA] = [scatter.find((k) => /FSC-A/i.test(k)) ?? scatter[0], scatter.find((k) => /SSC-A/i.test(k)) ?? scatter[1]];
  const fscH = scatter.find((k) => /FSC-H/i.test(k)) ?? scatter[2] ?? sscA;
  const [f1, f2] = fluor;
  expect(f2).toBeDefined();

  function build(): { tree: Tree; names: Record<string, string> } {
    const b = new TreeBuilder();
    // Raw polygon on linear axes: straight in the declared space, written verbatim.
    const scatterGate = b.gate(newGate("Scatter", "polygon", fscA, sscA, pentagon(sample, fscA, sscA)));
    const pScatter = b.pop("Scatter", [{ gate: scatterGate }], b.root);
    // Raw rectangle: exact under any axis.
    // Narrower than Scatter on purpose, so that NOT Singlets within Scatter holds events.
    const singlets = b.gate(newGate("Singlets", "rectangle", fscA, fscH,
      [[quantile(sample, fscA, 0.3), quantile(sample, fscH, 0.3)], [quantile(sample, fscA, 0.7), quantile(sample, fscH, 0.7)]]));
    const pSinglets = b.pop("Singlets", [{ gate: singlets }], pScatter);
    // Raw polygon on fluorescence: the file declares biex, so this one is densified.
    const rawFluor = b.gate(newGate("Fluor raw", "polygon", f1, f2, pentagon(sample, f1, f2)));
    const pRawFluor = b.pop("Fluor raw", [{ gate: rawFluor }], pSinglets);
    // A display-space (logicle) polygon on fluorescence: also not biex, also densified.
    const rawVerts = pentagon(sample, f1, f2);
    const dispGate: Gate = {
      ...newGate("Fluor logicle", "polygon", f1, f2, rawVerts),
      space: "display", transforms: sample.gateTransformSnapshot(f1, f2),
    } as Gate;
    (dispGate as { vertices: Vertex[] }).vertices = rawVerts.map(([x, y]) => [sample.rawToGate(dispGate, f1, x), sample.rawToGate(dispGate, f2, y)]);
    b.gate(dispGate);
    b.pop("Fluor logicle", [{ gate: dispGate }], pSinglets);
    // An ellipse on linear axes: FlowJo's foci form, exact.
    const ellipse: Gate = {
      gate_id: crypto.randomUUID(), name: "Scatter ellipse", gate_type: "ellipse", x_channel: fscA, y_channel: sscA,
      mean: [quantile(sample, fscA, 0.5), quantile(sample, sscA, 0.5)],
      covariance: (() => {
        const sx = (quantile(sample, fscA, 0.75) - quantile(sample, fscA, 0.25));
        const sy = (quantile(sample, sscA, 0.75) - quantile(sample, sscA, 0.25));
        return [[sx * sx, 0.3 * sx * sy], [0.3 * sx * sy, sy * sy]] as [[number, number], [number, number]];
      })(),
      distance_square: 1.5, color: "#000", label_offset: null, space: "raw",
    } as Gate;
    b.gate(ellipse);
    b.pop("Scatter ellipse", [{ gate: ellipse }], b.root);
    // A plain quadrant on fluorescence, four populations.
    const quad = b.gate(newQuadrantGate("Quad", f1, f2, [quantile(sample, f1, 0.5), quantile(sample, f2, 0.5)]));
    for (const q of [1, 2, 3, 4]) b.pop(`Quad Q${q}`, [{ gate: quad, quadrant: q }], pSinglets);
    // A bent quadrant as GateLab draws one on its own axes: in display (logicle) space, with
    // FlowJo's bend scaled to that space. The arms are traced, so its quadrants are bounded.
    const curlyBase = newQuadrantGate("Curly", f1, f2, [0, 0]);
    const curly = b.gate({
      ...curlyBase, space: "display", transforms: sample.gateTransformSnapshot(f1, f2),
      center: [sample.rawToDisplay(f1, quantile(sample, f1, 0.4)), sample.rawToDisplay(f2, quantile(sample, f2, 0.6))],
      curl: flowJoCurlForDisplay(1, 1),
    } as Gate);
    b.pop("Curly Q2", [{ gate: curly, quadrant: 2 }], pSinglets);
    b.pop("Curly Q4", [{ gate: curly, quadrant: 4 }], pSinglets);
    // NOT of a rectangle, and an AND of two gates, beneath the same parent.
    b.pop("Not singlets", [{ gate: singlets, include: false }], pScatter);
    b.pop("Singlets and fluor", [{ gate: singlets }, { gate: rawFluor }], pScatter);
    // A NOT beneath an AND, to check nesting under a Boolean node (of a gate the AND does not
    // already hold, or it would be empty).
    const pAnd = Object.values(b.populations).find((p) => p.name === "Singlets and fluor")!.population_id;
    b.pop("Not Q1 below and", [{ gate: quad, quadrant: 1, include: false }], pAnd);
    void pRawFluor;
    return { tree: b.tree(), names: { scatter: "Scatter" } };
  }

  it("round-trips every gate kind through the FlowJo importer with the same events", () => {
    const { tree } = build();
    const before = evaluate(sample, tree);
    const fresh = load(ARIA_SMALL);
    const { masks: after, warnings } = roundTrip({ sample, fileName: "sample_Bmem_purity_small.fcs", ...tree }, fresh);

    const exact = ["Scatter", "Singlets", "Scatter ellipse", "Quad Q1", "Quad Q2", "Quad Q3", "Quad Q4", "Not singlets"];
    const bounded = ["Fluor raw", "Fluor logicle", "Curly Q2", "Curly Q4", "Singlets and fluor", "Not Q1 below and"];
    for (const name of [...exact, ...bounded]) {
      expect(lookup(after, tree, name), `"${name}" survived the trip`).toBeDefined();
    }
    for (const name of exact) {
      const n = count(before.get(name)!);
      expect(n, `"${name}" holds events`).toBeGreaterThan(0);
      // A boundary event can differ by an ulp between the polygon test and the quadrant test.
      expect(moved(before.get(name)!, lookup(after, tree, name)!), name).toBeLessThanOrEqual(name.startsWith("Quad") ? 2 : 0);
    }
    for (const name of bounded) {
      const n = count(before.get(name)!);
      expect(n, `"${name}" holds events`).toBeGreaterThan(0);
      // The traced boundary is within 0.2% of the gate's extent of the true edge.
      const m = moved(before.get(name)!, lookup(after, tree, name)!);
      expect(m, `${name}: ${m} of ${n} moved`).toBeLessThanOrEqual(Math.max(2, Math.ceil(n * 0.005)));
    }
    // What was approximated is said, and nothing was left out.
    expect(warnings.some((w) => /extra vertices/.test(w))).toBe(true);
    expect(warnings.some((w) => /quadrant population/.test(w))).toBe(true);
    expect(warnings.some((w) => /helper population/.test(w))).toBe(true);
    expect(warnings.filter((w) => /left out/.test(w))).toEqual([]);
  });

  it("writes a raw polygon that reaches below FlowJo's default biex floor whole, on an axis that shows it", () => {
    // FlowJo's default width basis of -10 puts the biex floor near -113 on a 316,228 top. A gate
    // drawn in GateLab has no such floor: this one runs to -800 on x and -300 on y.
    const b = new TreeBuilder();
    const [x2, y2] = [quantile(sample, f1, 0.8), quantile(sample, f2, 0.8)];
    const deep = b.gate(newGate("Deep negative", "polygon", f1, f2, [[-800, -300], [x2, -300], [x2, y2], [(x2 - 800) / 2, y2 * 1.2], [-800, y2]]));
    b.pop("Deep negative", [{ gate: deep }], b.root);
    const tree = b.tree();
    const before = evaluate(sample, tree);
    const fresh = load(ARIA_SMALL);
    const { masks: after, xml, warnings } = roundTrip({ sample, fileName: "sample_Bmem_purity_small.fcs", ...tree }, fresh);

    const pnnX = sample.channels[sample.index(f1)!].pnn;
    const pnnY = sample.channels[sample.index(f2)!].pnn;
    for (const [pnn, need] of [[pnnX, -800], [pnnY, -300]] as const) {
      const decl = declaredBiex(xml, pnn)!;
      expect(decl, pnn).not.toBeNull();
      expect(decl.width, `${pnn} declared wider than FlowJo's -10`).toBeLessThan(-10);
      const floor = biexTransform({ maxValue: decl.maxRange, pos: 4.5, neg: 0, widthBasis: decl.width, channelRange: 256 }).inverse(0);
      expect(floor, `${pnn}: the declared axis reaches the gate`).toBeLessThanOrEqual(need);
    }
    const written = writtenPolygon(xml, "Deep negative")!;
    expect(Math.min(...written.map((v) => v[0]))).toBeLessThanOrEqual(-800 * 0.99);
    expect(Math.min(...written.map((v) => v[1]))).toBeLessThanOrEqual(-300 * 0.99);
    expect(warnings.filter((w) => /outside the declared axis/.test(w))).toEqual([]);
    const n = count(before.get("Deep negative")!);
    expect(n).toBeGreaterThan(0);
    const m = moved(before.get("Deep negative")!, lookup(after, tree, "Deep negative")!);
    expect(m, `${m} of ${n} moved`).toBeLessThanOrEqual(Math.max(2, Math.ceil(n * 0.005)));
  });

  it("writes FlowJo's layout: one Sample per file, every parameter declared, counts on every node", () => {
    const { tree } = build();
    const { xml } = exportFlowJoWorkspace({ samples: [{ sample, fileName: "a.fcs", ...tree }], now: new Date("2026-09-14T00:00:00Z") });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<Workspace version="20.0"')).toBe(true);
    expect(xml).toContain('flowJoVersion="10.10.0"');
    expect((xml.match(/<Sample>/g) ?? []).length).toBe(1);
    expect(xml).toContain('<SampleNode name="a.fcs"');
    expect(xml).toContain(`count="${sample.fcs.nEvents}"`);
    // Every channel is declared, in FlowJo's vocabulary: biex for fluorescence, linear elsewhere.
    for (const c of sample.channels) expect(xml).toContain(`<data-type:parameter data-type:name="${c.pnn}" />`);
    expect(xml).toContain("<transforms:biex ");
    expect(xml).toContain("<transforms:linear ");
    expect(xml).not.toContain("<transforms:logicle ");
    // The quadrant is FlowJo's: four polygons, quadId 0..3, and the ellipse keeps its form.
    for (const q of [0, 1, 2, 3]) expect(xml).toContain(`quadId="${q}"`);
    expect(xml).toContain("<gating:EllipsoidGate ");
    expect(xml).toContain("<gating:foci>");
    // Boolean nodes name their siblings by path.
    expect(xml).toContain('<NotNode name="Not singlets"');
    expect(xml).toContain('<Dependent name="Scatter/Singlets" />');
    expect(xml).toContain('<AndNode name="Singlets and fluor"');
    // The FCS keywords ride along, which is how FACSChorus and FlowJo recognise the file.
    expect(xml).toContain('<Keyword name="$TOT"');
    expect(xml).toContain('<Keyword name="FJ_FCS_VERSION"');
  });

  it("names compensated parameters Comp- and writes the matrix when compensation is on", () => {
    if (!sample.hasCompensation) return;
    const { tree } = build();
    const before = evaluate(sample, tree);
    sample.setCompensation(true);
    try {
      const on = evaluate(sample, tree);
      // Compensation changes the fluorescence gates, so the trip is measured against the compensated truth.
      const fresh = load(ARIA_SMALL);
      const { masks: after, xml, conv } = roundTrip({ sample, fileName: "sample_Bmem_purity_small.fcs", ...tree }, fresh);
      expect(xml).toContain("<transforms:spilloverMatrix ");
      expect(xml).toContain(`data-type:name="Comp-${sample.channels[sample.index(f1)!].pnn}"`);
      expect(conv.spillover).not.toBeNull();
      expect(moved(on.get("Singlets")!, lookup(after, tree, "Singlets")!)).toBe(0);
      const n = count(on.get("Fluor raw")!);
      expect(moved(on.get("Fluor raw")!, lookup(after, tree, "Fluor raw")!)).toBeLessThanOrEqual(Math.max(2, Math.ceil(n * 0.005)));
      expect(before.get("Fluor raw")).toBeDefined();
    } finally {
      sample.setCompensation(false);
    }
  });

  it("writes one Sample per file, each with its own tree", () => {
    const { tree } = build();
    const b = new TreeBuilder();
    const g = b.gate(newGate("Only", "rectangle", fscA, sscA, [[quantile(sample, fscA, 0.2), quantile(sample, sscA, 0.2)], [quantile(sample, fscA, 0.8), quantile(sample, sscA, 0.8)]]));
    b.pop("Only", [{ gate: g }], b.root);
    const { xml, sampleCount } = exportFlowJoWorkspace({
      samples: [{ sample, fileName: "a.fcs", ...tree }, { sample, fileName: "b.fcs", ...b.tree() }],
      now: new Date("2026-09-14T00:00:00Z"),
    });
    expect(sampleCount).toBe(2);
    const summaries = listFlowJoWorkspaceSamples(xml);
    expect(summaries.map((s) => s.name)).toEqual(["a.fcs", "b.fcs"]);
    expect(summaries[1].trees.map((t) => t.name)).toEqual(["Only"]);
    expect(summaries[0].gateCount).toBeGreaterThan(summaries[1].gateCount);
    expect(xml).toContain('<SampleRef sampleID="2" />');
  });

  it("writes GateLab's groups as FlowJo groups over the same samples", () => {
    const { tree } = build();
    const { xml } = exportFlowJoWorkspace({
      samples: [{ sample, fileName: "a.fcs", ...tree }, { sample, fileName: "b.fcs", ...tree }],
      now: new Date("2026-09-14T00:00:00Z"),
      groups: [{ name: "Treated", fileNames: ["b.fcs"] }, { name: "Nobody", fileNames: ["c.fcs"] }],
    });
    // All Samples first, then the group with its members by sampleID; a group with no exported file is left out.
    const groups = xml.slice(xml.indexOf("<Groups>"), xml.indexOf("</Groups>"));
    expect(groups.indexOf('<GroupNode name="All Samples"')).toBeLessThan(groups.indexOf('<GroupNode name="Treated"'));
    const treated = groups.slice(groups.indexOf('<GroupNode name="Treated"'));
    expect(treated).toContain('<Group name="Treated" live="0" role="ws.group.standard"');
    expect(treated).toContain('<SampleRef sampleID="2" />');
    expect(treated).not.toContain('<SampleRef sampleID="1" />');
    expect(groups).not.toContain("Nobody");
    // The workspace still opens as two samples.
    expect(listFlowJoWorkspaceSamples(xml).map((s) => s.name)).toEqual(["a.fcs", "b.fcs"]);
  });

  it("refuses an export with nothing gated, and plans without evaluating", () => {
    const b = new TreeBuilder();
    expect(() => exportFlowJoWorkspace({ samples: [{ sample, fileName: "a.fcs", ...b.tree() }] })).toThrow(/No gates/);
    const { tree } = build();
    const plan = planFlowJoExport([{ sample, fileName: "a.fcs", ...tree }]);
    expect(plan.gateCount).toBeGreaterThan(0);
    expect(plan.warnings.some((w) => /extra vertices/.test(w))).toBe(true);
  });
});

describe.runIf(existsSync(CYTOF_FILE))("FlowJo workspace export, mass cytometry", () => {
  it("declares fasinh so that arcsinh-space gates go and come back exact", () => {
    const sample = load(CYTOF_FILE);
    expect(sample.instrument).toBe("cytof");
    // Metal channels, by $PnN ("...Dd" / "...Di"), skipping Time and event length.
    const keys = sample.channels.filter((c) => /D[di]$/.test(c.pnn) && sample.transformSpec(c.key).kind === "asinh").map((c) => c.key);
    expect(keys.length).toBeGreaterThan(4);
    const [x, y] = keys.slice(2, 4);
    const b = new TreeBuilder();
    const rawVerts = pentagon(sample, x, y);
    const g: Gate = { ...newGate("Metal poly", "polygon", x, y, rawVerts), space: "display", transforms: sample.gateTransformSnapshot(x, y) } as Gate;
    (g as { vertices: Vertex[] }).vertices = rawVerts.map(([vx, vy]) => [sample.rawToGate(g, x, vx), sample.rawToGate(g, y, vy)]);
    b.gate(g);
    const p = b.pop("Metal poly", [{ gate: g }], b.root);
    const r = b.gate({ ...newGate("Metal rect", "rectangle", x, y, [[quantile(sample, x, 0.3), quantile(sample, y, 0.3)], [quantile(sample, x, 0.9), quantile(sample, y, 0.9)]]), space: "display", transforms: sample.gateTransformSnapshot(x, y) } as Gate);
    (r as { vertices: Vertex[] }).vertices = (r as { vertices: Vertex[] }).vertices.map(([vx, vy]) => [sample.rawToGate(r, x, vx), sample.rawToGate(r, y, vy)]);
    b.pop("Metal rect", [{ gate: r }], p);
    const tree = b.tree();
    const before = evaluate(sample, tree);
    const fresh = load(CYTOF_FILE);
    const { masks: after, xml, warnings, conv } = roundTrip({ sample, fileName: "PBMC8_30min_patient1_BCR-XL.fcs", ...tree }, fresh);
    expect(xml).toContain("<transforms:fasinh ");
    expect(xml).not.toContain("<transforms:biex ");
    // Straight in the declared axis: written verbatim, no extra vertices, and read back exactly.
    expect(warnings.filter((w) => /extra vertices/.test(w))).toEqual([]);
    expect(conv.warnings.filter((w) => /could not be carried/.test(w))).toEqual([]);
    for (const name of ["Metal poly", "Metal rect"]) {
      expect(count(before.get(name)!)).toBeGreaterThan(0);
      expect(moved(before.get(name)!, after.get(name)!), name).toBe(0);
    }
  });
});

describe.runIf(existsSync(Z2DR_WORKSPACE))("a FlowJo workspace through GateLab and back", () => {
  it("re-exports FlowJo's own gates in their own biex space, with FlowJo's counts intact", () => {
    const text = readFileSync(Z2DR_WORKSPACE, "utf-8");
    const dir = dirname(Z2DR_WORKSPACE);
    const summaries = listFlowJoWorkspaceSamples(text).filter((s) => s.gateCount > 0);
    const found = summaries
      .map((s) => ({ s, file: s.candidateFileNames.map((n) => join(dir, n)).find((p) => existsSync(p)) }))
      .find((x): x is { s: (typeof summaries)[number]; file: string } => !!x.file);
    if (!found) return;
    const conv = flowJoWorkspaceToGatingML(text, found.s.index, null, undefined, { flowJoGrid: false });
    const sample = load(found.file);
    const pnn: Record<string, string> = {};
    for (const c of sample.channels) pnn[c.pnn] = c.key;
    const res = importGatingML(conv.gatingMl, sample.channels.map((c) => c.key), pnn, sample.instrument);
    const external = conv.spillover ? sample.externalSpilloverPreview(conv.spillover.matrix) : null;
    const comp = resolveGatingMLCompensation(res.compensation, res.compensation_refs, true, external?.display ?? sample.spillover ?? null);
    if (comp.target === true && conv.spillover && external?.display != null) {
      sample.installExternalSpillover(conv.spillover.matrix, conv.spillover.name || "the workspace", { replaceEmbedded: sample.spillover !== null });
    }
    if (comp.target !== null) sample.setCompensation(comp.target);
    const tree: Tree = { gates: res.gates, gate_order: Object.keys(res.gates), populations: res.populations, root_population_id: res.root_population_id };
    const before = evaluate(sample, tree);

    const fresh = load(found.file);
    const { masks: after, xml, warnings } = roundTrip({ sample, fileName: found.file.split("/").pop()!, ...tree }, fresh);
    // FlowJo's gates arrive in biex space and leave in it: no polygon needs tracing.
    expect(xml).toContain("<transforms:biex ");
    expect(warnings.filter((w) => /extra vertices/.test(w))).toEqual([]);
    let compared = 0;
    for (const [name, mask] of before) {
      const back = after.get(name);
      if (!back) continue;
      compared++;
      // The biex table is interpolated on the way out and on the way back, and FlowJo's
      // quadrant polygons share their divider edges, so an event on a boundary can land on the
      // other side of it.
      expect(moved(mask, back), name).toBeLessThanOrEqual(Math.max(5, Math.ceil(count(mask) * 0.002)));
    }
    expect(compared).toBeGreaterThan(5);
  });
});

describe.runIf(existsSync(Z2DR_WORKSPACE))("a FlowJo workspace through GateLab and back, on FlowJo's grid", () => {
  // The same trip with the import evaluating as FlowJo does. A polygon on FlowJo's grid goes back
  // as FlowJo's own raw vertices with its gateResolution, and comes back on the same channels. A
  // quadrant panel of FlowJo's (a polygon with quadId 0 to 3) is not on the grid -- FlowJo's rule
  // for it is not established -- and goes back as an ordinary polygon, quadId -1, which FlowJo
  // and this import then do grid: the one kind of gate the trip can change.
  it("brings every polygon that was on the grid back on the same channels", () => {
    const text = readFileSync(Z2DR_WORKSPACE, "utf-8");
    const dir = dirname(Z2DR_WORKSPACE);
    const summaries = listFlowJoWorkspaceSamples(text).filter((s) => s.gateCount > 0);
    const found = summaries
      .map((s) => ({ s, file: s.candidateFileNames.map((n) => join(dir, n)).find((p) => existsSync(p)) }))
      .find((x): x is { s: (typeof summaries)[number]; file: string } => !!x.file);
    if (!found) return;
    const sample = load(found.file);
    const tree = importWorkspace(text, sample, found.s.index, { flowJoGrid: true });
    const before = evaluate(sample, tree);
    const fresh = load(found.file);
    const { masks: after, xml } = roundTrip({ sample, fileName: found.file.split("/").pop()!, ...tree }, fresh, { flowJoGrid: true });
    expect(xml).toContain('gateResolution="256"');
    // Populations whose every gate, up to the root, was on the grid or a rectangle: exact.
    const exactly = (pid: string): boolean => {
      for (let p = tree.populations[pid]; p && p.population_id !== tree.root_population_id; p = tree.populations[p.parent_id ?? ""]) {
        for (const ref of p.gate_refs) {
          const g = tree.gates[ref.gate_id];
          if (!g || (g.gate_type !== "rectangle" && !isFlowJoGridGate(g))) return false;
        }
      }
      return true;
    };
    let exact = 0;
    for (const [pid, pop] of Object.entries(tree.populations)) {
      if (pid === tree.root_population_id || !exactly(pid)) continue;
      const was = lookup(before, tree, pop.name);
      const back = lookup(after, tree, pop.name);
      if (!was || !back) continue;
      expect(moved(was, back), pop.name).toBe(0);
      exact++;
    }
    expect(exact).toBeGreaterThan(5);
  });
});

describe.runIf(existsSync(S6_WORKSPACE) && existsSync(S6_FCS))("the published S6 strategy through GateLab and back", () => {
  // Priest et al. 2024, Supplementary Figure 10A: 17 populations, polygons and rectangles in
  // biex space with FlowJo's own width bases per parameter, two polygons reaching well below
  // zero. This is the workspace whose export came back with two gates moved (2026-09-16).
  const text = readFileSync(S6_WORKSPACE, "utf-8");
  const fileName = S6_FCS.split("/").pop()!;
  const WIDTHS: Record<string, number> = { "BUV805-A": -60.315659717, "APC-Cy7-A": -60.315659717, "BV786-A": -36.9131837468, "PE-Cy7-A": -22.6786880536 };

  function polygonExtents(tree: Tree, sample: Sample): Map<string, { minX: number; minY: number }> {
    const out = new Map<string, { minX: number; minY: number }>();
    for (const g of Object.values(tree.gates)) {
      if (g.gate_type !== "polygon") continue;
      const xs = g.vertices.map((v) => sample.gateToRaw(g, g.x_channel, v[0]));
      const ys = g.vertices.map((v) => sample.gateToRaw(g, g.y_channel, v[1]));
      out.set(g.name, { minX: Math.min(...xs), minY: Math.min(...ys) });
    }
    return out;
  }

  // Both ways the import can evaluate FlowJo's gates. On FlowJo's grid a polygon goes back as the
  // raw vertices FlowJo saved, with its gateResolution, onto the very axis it was gridded on, so it
  // comes back on the same channels and no event moves; a rectangle, compared in raw units, keeps
  // the axis it was saved on (PolyRectGate.flowjo_axes) for the same reason.
  it.each([["continuously", false], ["on FlowJo's grid", true]] as const)("leaves in the biex it arrived in, whole, and comes back with every population intact, evaluated %s", (_, grid) => {
    const sample = load(S6_FCS);
    const tree = importWorkspace(text, sample, 0, { flowJoGrid: grid });
    expect(Object.keys(tree.populations).length).toBeGreaterThanOrEqual(18);
    const before = evaluate(sample, tree);
    const extents = polygonExtents(tree, sample);
    // The two polygons that were clipped: their true reach below zero.
    expect(extents.get("cd19+cd3-")!.minX).toBeLessThan(-600);
    expect(extents.get("NotDCs")!.minY).toBeLessThan(-190);

    const fresh = load(S6_FCS);
    const { masks: after, xml, warnings } = roundTrip({ sample, fileName, ...tree }, fresh, { flowJoGrid: grid });

    // FlowJo's own width bases go back verbatim, and no polygon is traced.
    for (const [pnn, width] of Object.entries(WIDTHS)) {
      const decl = declaredBiex(xml, pnn);
      expect(decl, pnn).not.toBeNull();
      expect(decl!.width, pnn).toBeCloseTo(width, 6);
    }
    expect(warnings.filter((w) => /extra vertices|outside the declared axis|FlowJo's grid/.test(w))).toEqual([]);
    for (const [name, ext] of extents) {
      const written = writtenPolygon(xml, name);
      expect(written, name).not.toBeNull();
      const gate = Object.values(tree.gates).find((g) => g.name === name);
      if (grid && gate?.gate_type === "polygon") {
        // FlowJo's own coordinates, exactly, at the precision the file writes.
        expect(gate.flowjo_vertices, name).toBeDefined();
        expect(written!.map(([x, y]) => [Number(x.toPrecision(12)), Number(y.toPrecision(12))]), name)
          .toEqual(gate.flowjo_vertices!.map(([x, y]) => [Number(x.toPrecision(12)), Number(y.toPrecision(12))]));
        expect(xml).toContain('gateResolution="256"');
        continue;
      }
      expect(Math.min(...written!.map((v) => v[0])), `${name} min x`).toBeLessThanOrEqual(ext.minX + Math.abs(ext.minX) * 0.01 + 1e-6);
      expect(Math.min(...written!.map((v) => v[1])), `${name} min y`).toBeLessThanOrEqual(ext.minY + Math.abs(ext.minY) * 0.01 + 1e-6);
    }
    let compared = 0;
    for (const [name, mask] of before) {
      if (name.includes("/")) continue;
      const back = lookup(after, tree, name);
      expect(back, name).toBeDefined();
      compared++;
      const n = count(mask);
      const m = moved(mask, back!);
      expect(m, `${name}: ${m} of ${n} moved`).toBeLessThanOrEqual(grid ? 0 : Math.max(5, Math.ceil(n * 0.002)));
    }
    expect(compared).toBe(18);
  });

  it("goes whole when the same gates are held in raw space", () => {
    // A workspace saved before gates carried a space holds these polygons as raw vertices. They
    // are then traced in the declared biex, which must reach every vertex.
    const sample = load(S6_FCS);
    const tree = inRawSpace(sample, importWorkspace(text, sample));
    const before = evaluate(sample, tree);
    const extents = polygonExtents(tree, sample);
    const fresh = load(S6_FCS);
    const { masks: after, xml, warnings } = roundTrip({ sample, fileName, ...tree }, fresh);
    expect(warnings.filter((w) => /outside the declared axis/.test(w))).toEqual([]);
    for (const [name, ext] of extents) {
      const written = writtenPolygon(xml, name)!;
      expect(Math.min(...written.map((v) => v[0])), `${name} min x`).toBeLessThanOrEqual(ext.minX + Math.abs(ext.minX) * 0.01 + 1e-6);
      expect(Math.min(...written.map((v) => v[1])), `${name} min y`).toBeLessThanOrEqual(ext.minY + Math.abs(ext.minY) * 0.01 + 1e-6);
    }
    let compared = 0;
    for (const [name, mask] of before) {
      if (name.includes("/")) continue;
      const back = lookup(after, tree, name);
      expect(back, name).toBeDefined();
      compared++;
      const n = count(mask);
      const m = moved(mask, back!);
      expect(m, `${name}: ${m} of ${n} moved`).toBeLessThanOrEqual(Math.max(5, Math.ceil(n * 0.005)));
    }
    expect(compared).toBe(18);
  });

  it.each([["continuously", false], ["on FlowJo's grid", true]] as const)("changes nothing on a second trip, evaluated %s", (_, grid) => {
    const sample = load(S6_FCS);
    const tree = importWorkspace(text, sample, 0, { flowJoGrid: grid });
    const first = exportFlowJoWorkspace({ samples: [{ sample, fileName, ...tree }], now: new Date("2026-09-16T00:00:00Z"), producer: "GateLab test" }).xml;
    const again = load(S6_FCS);
    const tree2 = importWorkspace(first, again, 0, { flowJoGrid: grid });
    const second = exportFlowJoWorkspace({ samples: [{ sample: again, fileName, ...tree2 }], now: new Date("2026-09-16T00:00:00Z"), producer: "GateLab test" }).xml;
    let polygons = 0;
    for (const g of Object.values(tree.gates)) {
      if (g.gate_type !== "polygon") continue;
      const a = writtenPolygon(first, g.name)!;
      const b = writtenPolygon(second, g.name)!;
      expect(b.length, g.name).toBe(a.length);
      for (let i = 0; i < a.length; i++) {
        expect(b[i][0], `${g.name} vertex ${i} x`).toBeCloseTo(a[i][0], 3);
        expect(b[i][1], `${g.name} vertex ${i} y`).toBeCloseTo(a[i][1], 3);
      }
      polygons++;
    }
    expect(polygons).toBeGreaterThanOrEqual(5);
    for (const pnn of Object.keys(WIDTHS)) {
      expect(declaredBiex(second, pnn)!.width).toBeCloseTo(declaredBiex(first, pnn)!.width, 6);
    }
  });
});


// A Gating-ML import holds an absent bound as ±UNBOUNDED. FlowJo export wrote any bound it could
// not map to a finite raw value as 0 (fmtNum's non-finite fallback), which emptied an open-top
// logicle range, and an UNBOUNDED raw bound as a number past the largest double.
describe.runIf(existsSync(ARIA_SMALL))("FlowJo export of an unbounded rectangle edge", () => {
  const sample = load(ARIA_SMALL);
  const fluor = sample.channels.filter((_, i) => sample.isFluorChannel(i)).map((c) => c.key);
  const fsc = sample.channels.find((c) => /FSC-A/.test(c.key))!.key;
  const [f1, f2] = fluor;
  const U = Number.MAX_VALUE;

  it("writes it as no bound, and the importer reads back the same events", () => {
    const b = new TreeBuilder();
    const lg = sample.gateTransformSnapshot(f1, f2);
    const openTop = b.gate({ ...newGate("Open-top logicle", "rectangle", f1, f2, [[0.3, 0.2], [0.8, U]]), space: "display", transforms: lg } as Gate);
    b.pop("Open-top logicle", [{ gate: openTop }], b.root);
    const openRaw = b.gate(newGate("Open raw", "rectangle", fsc, f1, [[quantile(sample, fsc, 0.3), -U], [U, quantile(sample, f1, 0.6)]]));
    b.pop("Open raw", [{ gate: openRaw }], b.root);
    const tree = b.tree();
    const before = evaluate(sample, tree);
    const { masks: after, xml } = roundTrip({ sample, fileName: "sample_Bmem_purity_small.fcs", ...tree }, load(ARIA_SMALL));
    for (const d of xml.match(/<gating:dimension\b[^>]*>/g) ?? []) {
      expect(d).not.toMatch(/gating:(min|max)="0"/);
      expect(d).not.toMatch(/e\+308/);
    }
    for (const name of ["Open-top logicle", "Open raw"]) {
      const n = count(before.get(name)!);
      expect(n, name).toBeGreaterThan(0);
      expect(moved(before.get(name)!, lookup(after, tree, name)!), name).toBe(0);
    }
  });
});


// A bent quadrant's arm, sampled to the edge of the box the export draws around the data, can
// run past every finite raw value on an axis whose display grows slowly: on an asinh y, a bend of
// 1,300 display units is a raw value beyond the largest double. Such a vertex was written as 0 (fmtNum's
// non-finite fallback) until 2026-09, and the Gating-ML hardening branch then refused the whole
// workspace for it. No event lies beyond the box, so the arm is held to the box: every event keeps
// the side of the arm it was on.
describe("FlowJo export of a bent quadrant whose arm leaves every finite raw value", () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const n = 4000;
  const fl1 = new Float32Array(n);
  const fl2 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    fl1[i] = -500 + 260000 * rand() ** 3;
    fl2[i] = -130 + 260000 * rand() ** 3;
  }
  const bytes = writeFcs([new Float32Array(n).map((_, i) => 1000 + (i % 50) * 10), fl1, fl2], [
    { name: "FSC-A", desc: "" }, { name: "FL1-A", desc: "" }, { name: "FL2-A", desc: "" },
  ]);
  const read = () => new Sample(parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
  const sample = read();
  const [x, y] = [sample.channels[1].key, sample.channels[2].key];

  it("writes finite vertices, and the importer reads back each quadrant's events", () => {
    const b = new TreeBuilder();
    const base = newQuadrantGate("Bent", x, y, [0, 0]);
    const bent = b.gate({
      ...base, space: "display",
      transforms: { [x]: { kind: "identity" }, [y]: { kind: "asinh", cofactor: 150 } },
      center: [2000, Math.asinh(900 / 150)],
      curl: { power: 1.5, kx: 1e-5, ky: 0.0025 },
    } as Gate);
    for (const q of [1, 2, 3, 4]) b.pop(`Bent Q${q}`, [{ gate: bent, quadrant: q }], b.root);
    const tree = b.tree();
    const before = evaluate(sample, tree);
    const { masks: after, xml } = roundTrip({ sample, fileName: "bent.fcs", ...tree }, read());
    for (const v of xml.matchAll(/data-type:value="([^"]+)"/g)) expect(Number.isFinite(Number(v[1])), v[1]).toBe(true);
    for (const q of [1, 2, 3, 4]) {
      const name = `Bent Q${q}`;
      expect(count(before.get(name)!), name).toBeGreaterThan(0);
      const m = moved(before.get(name)!, lookup(after, tree, name)!);
      expect(m, `${name}: ${m} moved`).toBeLessThanOrEqual(Math.max(2, Math.ceil(count(before.get(name)!) * 0.005)));
    }
  });
});

// A FlowJo workspace GateLab wrote, read back with "Evaluate gates as FlowJo does" on (the default).
// A polygon GateLab drew goes to the file with gateResolution 256, since FlowJo grids every polygon
// it draws (feat/flowjo-grid), and the grid then took it back in quantised: the public PBMC
// bundle's PBMC morphology went from 87,764 events to 87,910, Singlets from 85,478 to 85,622. Each
// such polygon now carries GateLab's mark of its written vertices (WSP_OWN_POLYGON_ATTR), and comes
// back evaluated on its drawn lines while the vertices are still the ones GateLab wrote; FlowJo's
// own polygons, and one edited since, are put on the grid as before.
describe("a polygon GateLab drew, through its own FlowJo workspace with the grid on", () => {
  let seed = 11;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const n = 20000;
  // Integer-valued scatter, as instruments record it, so that events lie on every grid channel.
  const fsc = new Float32Array(n).map(() => Math.round(20000 + 200000 * rand()));
  const ssc = new Float32Array(n).map(() => Math.round(5000 + 150000 * rand()));
  const fl1 = new Float32Array(n).map(() => -300 + 100000 * rand() ** 3);
  const fl2 = new Float32Array(n).map(() => -200 + 100000 * rand() ** 3);
  const bytes = writeFcs([fsc, ssc, fl1, fl2], [
    { name: "FSC-A", desc: "" }, { name: "SSC-A", desc: "" }, { name: "FL1-A", desc: "" }, { name: "FL2-A", desc: "" },
  ]);
  const read = () => new Sample(parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
  const sample = read();
  const [fscKey, sscKey, x, y] = sample.channels.map((c) => c.key);
  const build = () => {
    const b = new TreeBuilder();
    const morphology = b.gate({
      ...newGate("Morphology", "polygon", fscKey, sscKey, [[40000.3, 20000.7], [180000.2, 30000.1], [200000.9, 140000.4], [60000.5, 120000.2]]),
      space: "raw",
    } as Gate);
    const cells = b.pop("Cells", [{ gate: morphology }], b.root);
    const fl = b.gate({
      ...newGate("FL1 pos", "polygon", x, y, [[Math.asinh(500 / 150), Math.asinh(-100 / 150)], [Math.asinh(90000 / 150), Math.asinh(200 / 150)], [Math.asinh(60000 / 150), Math.asinh(80000 / 150)]]),
      space: "display", transforms: { [x]: { kind: "asinh", cofactor: 150 }, [y]: { kind: "asinh", cofactor: 150 } },
    } as Gate);
    b.pop("FL1 pos", [{ gate: fl }], cells);
    return b.tree();
  };

  it("comes back holding the events it held, as with the grid off, and still goes to FlowJo on its grid", () => {
    const tree = build();
    const before = evaluate(sample, tree);
    const off = roundTrip({ sample, fileName: "drawn.fcs", ...tree }, read(), { flowJoGrid: false });
    const on = roundTrip({ sample, fileName: "drawn.fcs", ...tree }, read(), { flowJoGrid: true });
    // FlowJo still grids both polygons, as it does every polygon it draws.
    expect([...on.xml.matchAll(/<gating:PolygonGate [^>]*gateResolution="256"/g)]).toHaveLength(2);
    expect(on.conv.gridPolygons).toBe(0);
    expect(count(before.get("Cells")!)).toBeGreaterThan(1000);
    expect(moved(before.get("Cells")!, lookup(on.masks, tree, "Cells")!)).toBe(0);
    for (const name of ["Cells", "FL1 pos"]) {
      expect(moved(lookup(off.masks, tree, name)!, lookup(on.masks, tree, name)!), name).toBe(0);
    }
  });

  it("puts a polygon on FlowJo's grid once its vertices are no longer the ones GateLab wrote", () => {
    const tree = build();
    const { xml } = exportFlowJoWorkspace({ samples: [{ sample, fileName: "drawn.fcs", ...tree }], now: new Date("2026-09-14T00:00:00Z"), producer: "GateLab test" });
    // Another program moved the morphology polygon's first vertex and kept the attribute.
    const edited = xml.replace(/(<gating:PolygonGate [^>]*>[\s\S]*?<gating:coordinate data-type:value=")([^"]+)"/, (_, pre, v) => `${pre}${Number(v) + 1000}"`);
    expect(edited).not.toBe(xml);
    expect(flowJoWorkspaceToGatingML(edited, 0, null, undefined, { flowJoGrid: true }).gridPolygons).toBe(1);
    // Read with the mark gone, as FlowJo saving the file leaves it, both are FlowJo's polygons.
    const stripped = xml.replace(/ gatelabPolygon="[^"]*"/g, "");
    expect(stripped).not.toBe(xml);
    expect(flowJoWorkspaceToGatingML(stripped, 0, null, undefined, { flowJoGrid: true }).gridPolygons).toBe(2);
  });
});

// FlowJo names a population by its path, and a name may recur down a branch ("Single Cells" under
// "Single Cells"). The importer qualifies a recurring name with as many parents as it takes
// ("Lymphocytes/Single Cells", "Single Cells/Single Cells"; flowjoWorkspace.ts,
// qualifiedPopulationNames), and the FlowJo export wrote those names as they stand, "/" and all:
// FlowJo to GateLab to FlowJo renamed every such population (the release candidate's browser
// verifier; master the same). Synthetic names and events.
describe("FlowJo export of populations the importer qualified by their parents", () => {
  const n = 400;
  const fsc = new Float32Array(n).map((_, i) => 1000 + (i % 40) * 1000);
  const ssc = new Float32Array(n).map((_, i) => 1000 + Math.floor(i / 10) * 1000);
  const bytes = writeFcs([fsc, ssc], [{ name: "FSC-A", desc: "" }, { name: "SSC-A", desc: "" }]);
  const read = () => new Sample(parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
  const G = "http://www.isac-net.org/std/Gating-ML/v2.0/gating";
  const D = "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes";
  const rect = (id: string, hi: number) => `<Gate gating:id="${id}"><gating:RectangleGate gating:id="${id}">
    <gating:dimension gating:min="0" gating:max="${hi}"><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
    <gating:dimension gating:min="0" gating:max="${hi}"><data-type:fcs-dimension data-type:name="SSC-A"/></gating:dimension>
  </gating:RectangleGate></Gate>`;
  const WSP = `<?xml version="1.0"?><Workspace flowJoVersion="10.8.1" xmlns:gating="${G}" xmlns:data-type="${D}"><SampleList><Sample><DataSet uri="file:D1.fcs"/>
    <SampleNode name="D1.fcs" count="${n}"><Subpopulations>
      <Population name="Lymphocytes" count="0">${rect("g1", 30000)}<Subpopulations>
        <Population name="Single Cells" count="0">${rect("g2", 25000)}<Subpopulations>
          <Population name="Single Cells" count="0">${rect("g3", 20000)}<Subpopulations>
            <Population name="CD4_positive" count="0">${rect("g4", 10000)}</Population>
          </Subpopulations></Population>
        </Subpopulations></Population>
      </Subpopulations></Population>
    </Subpopulations></SampleNode></Sample></SampleList></Workspace>`;

  it("writes FlowJo's own names back, and the importer qualifies them the same way again", () => {
    const sample = read();
    const tree = importWorkspace(WSP, sample);
    const names = Object.values(tree.populations).map((p) => p.name).sort();
    expect(names).toEqual(["All Events", "CD4_positive", "Lymphocytes", "Lymphocytes/Single Cells", "Single Cells/Single Cells"]);
    const before = evaluate(sample, tree);
    const { xml, warnings } = exportFlowJoWorkspace({
      samples: [{ sample, fileName: "D1.fcs", ...tree }], now: new Date("2026-09-25T00:00:00Z"), producer: "GateLab test",
    });
    const written = [...xml.matchAll(/<Population name="([^"]+)"/g)].map((m) => m[1]);
    expect(written).toEqual(["Lymphocytes", "Single Cells", "Single Cells", "CD4_positive"]);
    expect(warnings.join(" ")).not.toContain('contains "/"');
    const again = importWorkspace(xml, read());
    expect(Object.values(again.populations).map((p) => p.name).sort()).toEqual(names);
    const after = evaluate(read(), again);
    for (const name of names.filter((x) => x !== "All Events")) {
      expect(moved(before.get(name)!, lookup(after, again, name)!), name).toBe(0);
    }
  });

  it("writes a name with a \"/\" that is not its parents' as it stands, and says so", () => {
    const sample = read();
    const tree = importWorkspace(WSP, sample);
    const cd4 = Object.values(tree.populations).find((p) => p.name === "CD4_positive")!;
    cd4.name = "CD4/CD8";
    const { xml, warnings } = exportFlowJoWorkspace({
      samples: [{ sample, fileName: "D1.fcs", ...tree }], now: new Date("2026-09-25T00:00:00Z"), producer: "GateLab test",
    });
    expect([...xml.matchAll(/<Population name="([^"]+)"/g)].map((m) => m[1])).toContain("CD4/CD8");
    expect(warnings.join(" ")).toContain('"CD4/CD8" contains "/"');
  });
});

// A gate in Gating-ML's flog goes to FlowJo on a log axis. It was declared with FlowJo's offset at
// flog's T, where flog is 1, not 0: the same straight lines, but FlowJo puts every event below its
// offset on the axis's floor, so it read every event below T there, and a rectangle's lower bound
// at or below T was opened by FlowJo's rule (the interoperability sweep's fail:flowjo-log-offset,
// 131 checks on 0.8.3; random-0041 "IFN-γ" 3,562 of 10,000 events). Synthetic names and events.
describe("FlowJo export of a gate in Gating-ML's flog", () => {
  const fsc = Float32Array.from([50000, 50000, 50000, 50000, 50000, 50000]);
  const fl = Float32Array.from([0.5, 100, 999, 1001, 5000, 300000]);
  const bytes = writeFcs([fsc, fl], [{ name: "FSC-A", desc: "" }, { name: "FL1-A", desc: "CD4" }]);
  const read = () => new Sample(parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));

  it("is declared on FlowJo's log at flog's own zero, and read by FlowJo's rule as GateLab holds it", () => {
    const sample = read();
    const [x, y] = [sample.channels[0].key, sample.channels[1].key];
    const flog = { kind: "flog" as const, T: 262144, M: 4.5 };
    const f = (v: number) => Math.log10(v / flog.T) / flog.M + 1;
    const b = new TreeBuilder();
    const gate = b.gate({
      ...newGate("Box", "rectangle", x, y, [[0, f(1000)], [100000, f(400000)]]),
      space: "display", transforms: { [x]: { kind: "identity" }, [y]: flog }, bounds: "closed",
    } as Gate);
    b.pop("CD4_positive", [{ gate }], b.root);
    const tree = b.tree();
    const before = evaluate(sample, tree).get("CD4_positive")!;
    expect(Array.from(before)).toEqual([0, 0, 0, 1, 1, 1]);
    const { xml } = exportFlowJoWorkspace({ samples: [{ sample, fileName: "D1.fcs", ...tree }], now: new Date("2026-09-25T00:00:00Z"), producer: "GateLab test" });
    const axis = xml.match(/<transforms:log transforms:offset="([^"]+)" transforms:decades="([^"]+)">\s*<data-type:parameter data-type:name="FL1-A"/)!;
    expect(Number(axis[1])).toBeCloseTo(262144 * 10 ** -4.5, 9);
    expect(Number(axis[2])).toBe(4.5);
    // FlowJo's reading: GateLab's record taken out, the importer's FlowJo rule on.
    const bare = xml.replace(/ gatelabRectangle="[^"]*"/g, "");
    const fresh = read();
    const flowJo = importWorkspace(bare, fresh, 0, { flowJoGrid: true });
    expect(moved(before, evaluate(fresh, flowJo).get("CD4_positive")!)).toBe(0);
  });
});

// A channel another gate holds on flog (or FlowJo's log) was declared as FlowJo's log, and FlowJo puts
// every event below the log's offset on the offset before it compares a rectangle's bounds. A GateLab
// rectangle on logicle, arcsinh or raw values beside it, with a bound at or below the offset, then
// held other events for FlowJo: the sweep's fail:flowjo-axis-range rows, 36 of 43 (the corpus's
// rect-edges-display "asinh" 3,785 events in GateLab against 5,366 read by FlowJo's rule; the release
// candidate's verifier). The channel is declared as FlowJo would declare it for a new sample, a
// rectangle on the log goes out in raw values with no lower bound where it holds the log's floor, a
// polygon on the log reaching below its floor goes out cut at the floor and skirted below it, and
// FlowJo reads every gate as GateLab holds it. Where a gate needs the log (a polygon FlowJo grids on
// it), the channel keeps it and the export names the events FlowJo moves. Synthetic names and events.
describe("FlowJo export of a rectangle reaching below a declared log axis's floor", () => {
  const fsc = Float32Array.from([50000, 50000, 50000, 50000, 50000, 50000, 50000]);
  const fl = Float32Array.from([-500, -400, -50, 5, 500, 5000, 50000]);
  const bytes = writeFcs([fsc, fl], [{ name: "FSC-A", desc: "" }, { name: "FL1-A", desc: "CD4" }]);
  const read = () => new Sample(parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
  const flog = { kind: "flog" as const, T: 262144, M: 4.5 };

  function build(sample: Sample, lo: number, hi: number, logShape: "none" | "polygon" | "grid" = "grid", floorBox = false): Tree {
    const [x, y] = [sample.channels[0].key, sample.channels[1].key];
    const b = new TreeBuilder();
    const onLog = b.gate({
      ...newGate("On log", "rectangle", x, y, [[0, floorBox ? -0.1 : 0.3], [100000, 0.9]]),
      space: "display", transforms: { [x]: { kind: "identity" }, [y]: flog }, bounds: "closed",
    } as Gate);
    b.pop("On_log", [{ gate: onLog }], b.root);
    if (logShape === "polygon") {
      // A polygon on flog reaching below its floor, which went out on FlowJo's log for itself until
      // 2026-09-26: now cut at the floor and skirted below it on the other axis.
      const shape = b.gate({
        ...newGate("Log shape", "polygon", x, y, [[20000, -0.2], [90000, -0.05], [90000, 0.95], [20000, 0.95]]),
        space: "display", transforms: { [x]: { kind: "identity" }, [y]: flog },
      } as Gate);
      b.pop("Log_shape", [{ gate: shape }], b.root);
    } else if (logShape === "grid") {
      // A polygon FlowJo grids on its log (imported from FlowJo): the channel keeps the log for it.
      const shape = b.gate({
        ...newGate("Log shape", "polygon", x, y, [[20, 10], [90, 10], [90, 240], [20, 240]]),
        space: "display",
        transforms: {
          [x]: { kind: "flowjoChannels", channels: 256, axis: { kind: "linear", minRange: 0, maxRange: 262144 } },
          [y]: { kind: "flowjoChannels", channels: 256, axis: { kind: "wsplog", offset: flog.T * 10 ** -flog.M, decades: flog.M } },
        },
      } as Gate);
      b.pop("Log_shape", [{ gate: shape }], b.root);
    }
    const drawn = b.gate({ ...newGate("Drawn", "rectangle", x, y, [[0, lo], [100000, hi]]), space: "raw" as const } as Gate);
    b.pop("Drawn_cells", [{ gate: drawn }], b.root);
    return b.tree();
  }

  it("declares the channel otherwise where no gate needs the log, and FlowJo's rule reads every gate as GateLab holds it", () => {
    for (const [lo, hi, floorBox, shape] of [
      [-100, 1000, false, "none"], [-450, -100, false, "none"], [-100, 1000, true, "none"],
      [-100, 1000, false, "polygon"], [-450, -100, false, "polygon"], [-100, 1000, true, "polygon"],
    ] as const) {
      const sample = read();
      const tree = build(sample, lo, hi, shape, floorBox);
      const before = evaluate(sample, tree);
      const { xml, warnings } = exportFlowJoWorkspace({ samples: [{ sample, fileName: "D1.fcs", ...tree }], now: new Date("2026-09-26T00:00:00Z"), producer: "GateLab test" });
      expect(xml, `${lo} to ${hi}`).not.toMatch(/<transforms:log [^>]*>\s*<data-type:parameter data-type:name="FL1-A"/);
      expect(declaredBiex(xml, "FL1-A"), `${lo} to ${hi}`).not.toBeNull();
      expect(warnings.filter((w) => /an edge FlowJo moves events onto/.test(w)), `${lo} to ${hi}`).toEqual([]);
      // FlowJo's reading: GateLab's record taken out, the importer's FlowJo rule on.
      const fresh = read();
      const flowJo = evaluate(fresh, importWorkspace(xml.replace(/ gatelabRectangle="[^"]*"/g, ""), fresh, 0, { flowJoGrid: true }));
      for (const name of ["On_log", "Drawn_cells"]) {
        expect(moved(before.get(name)!, flowJo.get(name)!), `${name}, ${lo} to ${hi}${floorBox ? ", on the floor" : ""}, ${shape}`).toBe(0);
      }
      if (shape === "polygon") {
        // Below the floor, the polygon holds the events GateLab puts on it, through a skirt: read as
        // FlowJo draws it, continuously in the declared display, GateLab's polygon record taken out.
        expect(Array.from(before.get("Log_shape")!).slice(0, 4), `${lo} to ${hi}`).toEqual([1, 1, 1, 1]);
        const again = read();
        const polys = evaluate(again, importWorkspace(xml.replace(/ gatelabPolygon="[^"]*"/g, ""), again, 0, { flowJoGrid: false }));
        expect(moved(before.get("Log_shape")!, polys.get("Log_shape")!), `Log_shape, ${lo} to ${hi}`).toBe(0);
      }
      if (floorBox) {
        // On the floor, the log rectangle holds every event below the log's offset, and goes out with no lower bound.
        expect(Array.from(before.get("On_log")!).slice(0, 4)).toEqual([1, 1, 1, 1]);
        const rect = xml.match(/<gating:RectangleGate [^>]*>[\s\S]*?<\/gating:RectangleGate>/)![0];
        const dim = rect.match(/<gating:dimension([^>]*)>\s*<data-type:fcs-dimension data-type:name="FL1-A"/)!;
        expect(dim[1]).not.toMatch(/gating:min=/);
      }
    }
  });

  it("names the events FlowJo moves onto the floor and counts otherwise, as FlowJo's rule reads them", () => {
    const sample = read();
    const tree = build(sample, -100, 1000);
    const before = evaluate(sample, tree).get("Drawn_cells")!;
    expect(Array.from(before)).toEqual([0, 0, 1, 1, 1, 0, 0]);
    const { xml, warnings } = exportFlowJoWorkspace({ samples: [{ sample, fileName: "D1.fcs", ...tree }], now: new Date("2026-09-26T00:00:00Z"), producer: "GateLab test" });
    const named = warnings.filter((w) => w.startsWith('"Drawn" has a bound at or beyond an edge FlowJo moves events onto'));
    expect(named).toHaveLength(1);
    expect(named[0]).toContain("FL1-A below 8.2");
    expect(named[0]).toContain("the floor of the log axis from 8.2");
    expect(named[0]).toContain("FlowJo counts 2 events of this file otherwise than GateLab does.");
    // FlowJo's reading, GateLab's record taken out: the two events below -100 are inside.
    const fresh = read();
    const flowJo = importWorkspace(xml.replace(/ gatelabRectangle="[^"]*"/g, ""), fresh, 0, { flowJoGrid: true });
    expect(Array.from(evaluate(fresh, flowJo).get("Drawn_cells")!)).toEqual([1, 1, 1, 1, 1, 0, 0]);
    // GateLab's own reading uses its record.
    const again = read();
    expect(moved(before, evaluate(again, importWorkspace(xml, again, 0, { flowJoGrid: true })).get("Drawn_cells")!)).toBe(0);
  });

  it("names a rectangle wholly below the floor by the events FlowJo moves onto it", () => {
    const sample = read();
    const tree = build(sample, -450, -100);
    expect(Array.from(evaluate(sample, tree).get("Drawn_cells")!)).toEqual([0, 1, 0, 0, 0, 0, 0]);
    const { warnings } = exportFlowJoWorkspace({ samples: [{ sample, fileName: "D1.fcs", ...tree }], now: new Date("2026-09-26T00:00:00Z"), producer: "GateLab test" });
    const named = warnings.filter((w) => w.startsWith('"Drawn" lies at or beyond an edge FlowJo moves events onto'));
    expect(named).toHaveLength(1);
    expect(named[0]).toContain("FlowJo moves the 4 events of this file beyond it onto that edge, where the 1 of them GateLab holds cannot be told from the rest.");
  });

  it("says nothing of a rectangle above the floor, or of one whose events below it FlowJo counts alike", () => {
    for (const [lo, hi] of [[100, 1000], [-1000, 1000]]) {
      const sample = read();
      const { warnings } = exportFlowJoWorkspace({ samples: [{ sample, fileName: "D1.fcs", ...build(sample, lo, hi) }], now: new Date("2026-09-26T00:00:00Z"), producer: "GateLab test" });
      expect(warnings.filter((w) => /an edge FlowJo moves events onto/.test(w)), `${lo} to ${hi}`).toEqual([]);
    }
  });
});

// Where no biex width reaches the lowest value a gate on a channel states (a bound near -1e9, say),
// the export declared the last width it tried, -100,000, whose floor the biex's width clamp puts at
// about -27 on a 316,228 top, where -1,000 reaches -15,828: a raw ellipse beside it reaching -2,691
// went out clipped at -27 (the sweep's random-0005 "Lymphocytes", fail:flowjo-axis-range). Synthetic
// names and events.
describe("FlowJo export of a channel no biex width reaches down to", () => {
  const fsc = Float32Array.from([20000, 30000, 40000, 50000, 60000, 70000]);
  const fl = Float32Array.from([-3000, -2000, 10, 100, 5000, 50000]);
  const bytes = writeFcs([fsc, fl], [{ name: "FSC-A", desc: "" }, { name: "FL1-A", desc: "CD4" }]);
  const read = () => new Sample(parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));

  it("declares the width whose floor lies lowest, and a gate within it goes out whole", () => {
    const sample = read();
    const [x, y] = [sample.channels[0].key, sample.channels[1].key];
    const b = new TreeBuilder();
    const far = b.gate({ ...newGate("Far", "rectangle", x, y, [[0, -5e8], [100000, 1000]]), space: "raw" as const, bounds: "closed" as const } as Gate);
    b.pop("Far_cells", [{ gate: far }], b.root);
    const deep = b.gate({ ...newGate("Deep", "polygon", x, y, [[15000, -2800], [45000, -2800], [45000, 200], [15000, 200]]), space: "raw" as const } as Gate);
    b.pop("Deep_cells", [{ gate: deep }], b.root);
    const tree = b.tree();
    const { xml, warnings } = exportFlowJoWorkspace({ samples: [{ sample, fileName: "D1.fcs", ...tree }], now: new Date("2026-09-26T00:00:00Z"), producer: "GateLab test" });
    expect(warnings.filter((w) => /^No biex width reaches/.test(w))).toHaveLength(1);
    const decl = declaredBiex(xml, "FL1-A")!;
    expect(decl).not.toBeNull();
    const neg = Number(xml.match(/<transforms:biex [^>]*transforms:neg="([^"]+)"[^>]*>\s*<data-type:parameter data-type:name="FL1-A"/)![1]);
    const floor = biexTransform({ maxValue: decl.maxRange, pos: 4.5, neg, widthBasis: decl.width, channelRange: 256, tableChannels: FLOWJO_BIEX_TABLE_CHANNELS }).inverse(0);
    expect(floor).toBeLessThanOrEqual(-2800);
    const written = writtenPolygon(xml, "Deep_cells")!;
    expect(Math.min(...written.map((v) => v[1]))).toBeLessThanOrEqual(-2800 * 0.99);
    expect(warnings.filter((w) => /^Deep: .*outside the declared axis/.test(w))).toEqual([]);
  });
});

// On a 1,000 top the widest biex width reaches -50, and a range from -52.2 went out with its lower
// bound below the floor, where FlowJo moves every event below the bound into the range (the public
// MACSQuant file's FL2-W, 408 events). FlowJo's extra negative decades reach it. Synthetic names and
// events.
describe("FlowJo export of a channel only extra negative decades reach down to", () => {
  const fsc = Float32Array.from([200, 300, 400, 500, 600, 700]);
  const fl = Float32Array.from([-400, -60, -52, -10, 20, 900]);
  const bytes = writeFcs([fsc, fl], [{ name: "FSC-A", desc: "" }, { name: "FL2-W", desc: "", range: 1000 }]);
  const read = () => new Sample(parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));

  it("declares the biex with the negative decades that reach the gate, and FlowJo's rule reads it as GateLab holds it", () => {
    const sample = read();
    const y = sample.channels[1].key;
    const b = new TreeBuilder();
    const range = b.gate({ ...newGate("Range", "rectangle", y, y, [[-55, -55], [15, 15]]), space: "raw" as const, bounds: "closed" as const } as Gate);
    b.pop("Range_cells", [{ gate: range }], b.root);
    const tree = b.tree();
    const before = evaluate(sample, tree).get("Range_cells")!;
    expect(Array.from(before)).toEqual([0, 0, 1, 1, 0, 0]);
    const { xml, warnings } = exportFlowJoWorkspace({ samples: [{ sample, fileName: "D1.fcs", ...tree }], now: new Date("2026-09-26T00:00:00Z"), producer: "GateLab test" });
    expect(warnings.filter((w) => /^No biex width reaches/.test(w))).toEqual([]);
    const m = xml.match(/<transforms:biex transforms:length="256" transforms:maxRange="([^"]+)" transforms:neg="([^"]+)" transforms:width="([^"]+)" transforms:pos="([^"]+)">\s*<data-type:parameter data-type:name="FL2-W"/)!;
    expect(Number(m[2])).toBeGreaterThan(0);
    const floor = biexTransform({ maxValue: Number(m[1]), pos: Number(m[4]), neg: Number(m[2]), widthBasis: Number(m[3]), channelRange: 256, tableChannels: FLOWJO_BIEX_TABLE_CHANNELS }).inverse(0);
    expect(floor).toBeLessThanOrEqual(-55);
    const fresh = read();
    const flowJo = evaluate(fresh, importWorkspace(xml.replace(/ gatelabRectangle="[^"]*"/g, ""), fresh, 0, { flowJoGrid: true }));
    expect(moved(before, flowJo.get("Range_cells")!)).toBe(0);
  });
});

// A polygon with vertices the declared axis cannot hold was named once for every such vertex: the
// verifier's FR-FCM-Z2HV case, once its export no longer failed (above), carried 5,406 warnings,
// 2,661 of them for one quadrant panel's vertices below the declared biex table. Synthetic names
// and events.
describe("FlowJo export of a polygon with many vertices beyond the declared axis", () => {
  const fsc = Float32Array.from([50000, 60000, 70000, 80000]);
  const fl = Float32Array.from([-50, 20, 500, 5000]);
  const bytes = writeFcs([fsc, fl], [{ name: "FSC-A", desc: "" }, { name: "FL1-A", desc: "CD4" }]);
  const read = () => new Sample(parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));

  it("names them once for the gate and axis, with how many and where", () => {
    const sample = read();
    const [x, y] = [sample.channels[0].key, sample.channels[1].key];
    const flog = { kind: "flog" as const, T: 262144, M: 4.5 };
    const b = new TreeBuilder();
    // A polygon FlowJo grids on its log declares FL1-A as that log, whose floor is flog's zero (about
    // 8.29).
    const onLog = b.gate({
      ...newGate("On log", "polygon", x, y, [[20, 10], [90, 10], [90, 240], [20, 240]]),
      space: "display",
      transforms: {
        [x]: { kind: "flowjoChannels", channels: 256, axis: { kind: "linear", minRange: 0, maxRange: 262144 } },
        [y]: { kind: "flowjoChannels", channels: 256, axis: { kind: "wsplog", offset: flog.T * 10 ** -flog.M, decades: flog.M } },
      },
    } as Gate);
    b.pop("On_log", [{ gate: onLog }], b.root);
    // A raw polygon, straight in raw values, half of its 40 vertices below that floor.
    const ring: Vertex[] = Array.from({ length: 40 }, (_, k): Vertex => {
      const t = (2 * Math.PI * k) / 40;
      return [65000 + 20000 * Math.cos(t), 1000 * Math.sin(t)];
    });
    const drawn = b.gate({ ...newGate("Drawn", "polygon", x, y, ring), space: "raw" as const } as Gate);
    b.pop("Drawn_cells", [{ gate: drawn }], b.root);
    const { warnings } = exportFlowJoWorkspace({ samples: [{ sample, fileName: "D1.fcs", ...b.tree() }], now: new Date("2026-09-26T00:00:00Z"), producer: "GateLab test" });
    const outside = warnings.filter((w) => /outside the declared axis/.test(w));
    expect(outside).toHaveLength(1);
    expect(outside[0]).toMatch(/^Drawn: \d+ vertices from -1000 to -?[\d.e-]+ on FL1-A lie outside the declared axis and are written at its edge\.$/);
    expect(Number(outside[0].match(/^Drawn: (\d+) vertices/)![1])).toBeGreaterThanOrEqual(19);
  });
});

// An intersection of gates no population holds alone goes to FlowJo as an AndNode naming a helper
// population per gate, beside it, as FlowJo's own tool writes one. Read back, every helper was a
// population of its own: on the public PBMC bundle "NK cells (2)" (4,800 events) and "CD14 low"
// (16,277), on the Bodenmiller bundle 10 per file (the release candidate's browser verifier; master
// the same). Synthetic names and events.
describe("FlowJo export of an intersection, read back", () => {
  const n = 400;
  const fsc = new Float32Array(n).map((_, i) => 1000 + (i % 20) * 1000);
  const ssc = new Float32Array(n).map((_, i) => 1000 + Math.floor(i / 20) * 1000);
  const bytes = writeFcs([fsc, ssc], [{ name: "FSC-A", desc: "" }, { name: "SSC-A", desc: "" }]);
  const read = () => new Sample(parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
  const sample = read();
  const [x, y] = [sample.channels[0].key, sample.channels[1].key];
  const box = (name: string, lo: number, hi: number) =>
    ({ ...newGate(name, "rectangle", x, y, [[lo, lo], [hi, hi]]), space: "raw" as const, bounds: "closed" as const }) as Gate;

  it("brings back the populations GateLab had, and no helper beside them", () => {
    const b = new TreeBuilder();
    const big = b.gate(box("Big box", 0, 15000));
    const small = b.gate(box("Small box", 0, 5000));
    const corner = b.gate(box("Corner", 12000, 30000));
    const cells = b.pop("Cells", [{ gate: big }], b.root);
    b.pop("NK_like", [{ gate: big }, { gate: small, include: false }], cells);
    b.pop("Mixed", [{ gate: small }, { gate: corner, include: false }], cells);
    const tree = b.tree();
    const before = evaluate(sample, tree);
    const { masks: after, xml, conv } = roundTrip({ sample, fileName: "D1.fcs", ...tree }, read());
    // The file carries the helpers FlowJo needs to resolve its AndNodes.
    expect(xml).toMatch(/<AndNode name="NK_like"/);
    expect([...xml.matchAll(/<(?:Population|NotNode) name="([^"]+)"/g)].length).toBeGreaterThan(3);
    const pnn: Record<string, string> = {};
    for (const c of sample.channels) pnn[c.pnn] = c.key;
    const res = importGatingML(conv.gatingMl, sample.channels.map((c) => c.key), pnn, sample.instrument);
    const names = Object.values(res.populations).map((p) => p.name).sort();
    expect(names).toEqual(["All Events", "Cells", "Mixed", "NK_like"]);
    for (const name of ["Cells", "NK_like", "Mixed"]) {
      expect(count(before.get(name)!), name).toBeGreaterThan(0);
      expect(moved(before.get(name)!, lookup(after, tree, name)!), name).toBe(0);
    }
  });

  // A helper is named after its gate, and an AndNode or a NotNode names it by its path, "/" between
  // the names. A gate named with a "/" ("B cells: CD20+/CD3-low", and five more, on the public
  // Bodenmiller bundle) made its helper's path read as one more population than it is, and FlowKit
  // 1.3.1 refused the whole workspace ("Gate name CD3-low was not found in gating strategy"; the
  // release candidate's verifier, 0.8.3 the same). The helper is written with the "/" as a division
  // slash, and read back its gate keeps its name.
  it("names an intersection's helpers by paths a reader can split, and the gates keep their names", () => {
    const b = new TreeBuilder();
    const big = b.gate(box("Big box", 0, 15000));
    const slash = b.gate(box("CD20_pos/CD3-low", 0, 5000));
    b.pop("B_like", [{ gate: big }, { gate: slash }], b.root);
    b.pop("NK_like", [{ gate: big }, { gate: slash, include: false }], b.root);
    const tree = b.tree();
    const before = evaluate(sample, tree);
    const { xml, warnings } = exportFlowJoWorkspace({ samples: [{ sample, fileName: "D1.fcs", ...tree }], now: new Date("2026-09-26T00:00:00Z"), producer: "GateLab test" });
    // Every Dependent, split on "/" as a reader that walks the tree by name splits it, from the
    // sample's top: the population it names is there.
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const kids = (el: Element): Element[] => {
      const sub = Array.from(el.children).find((c) => c.localName === "Subpopulations");
      return sub ? Array.from(sub.children).filter((c) => /^(Population|NotNode|AndNode|OrNode)$/.test(c.localName)) : [];
    };
    const top = doc.getElementsByTagName("SampleNode")[0];
    const dependents = Array.from(doc.getElementsByTagName("Dependent")).map((d) => d.getAttribute("name")!);
    expect(dependents.length).toBeGreaterThanOrEqual(4);
    const unresolved = dependents.filter((path) => {
      let at: Element | undefined = top;
      for (const part of path.split("/")) at = at ? kids(at).find((c) => c.getAttribute("name") === part) : undefined;
      return !at;
    });
    expect(unresolved).toEqual([]);
    expect(warnings.join(" ")).not.toContain('contains "/"');
    // Read back: the same populations and events, no helper among them, and the gate by its name.
    const { masks: after, conv } = roundTrip({ sample, fileName: "D1.fcs", ...tree }, read());
    const pnn: Record<string, string> = {};
    for (const c of sample.channels) pnn[c.pnn] = c.key;
    const res = importGatingML(conv.gatingMl, sample.channels.map((c) => c.key), pnn, sample.instrument);
    expect(Object.values(res.populations).map((p) => p.name).sort()).toEqual(["All Events", "B_like", "NK_like"]);
    expect(Object.values(res.gates).map((g) => g.name)).toContain("CD20_pos/CD3-low");
    for (const name of ["B_like", "NK_like"]) {
      expect(count(before.get(name)!), name).toBeGreaterThan(0);
      expect(moved(before.get(name)!, lookup(after, tree, name)!), name).toBe(0);
    }
  });

  // A population named with a "/" that excludes a gate of the same name has that gate's helper
  // beside it. Written with the division slash, the helper looked exactly like its sibling in
  // FlowJo, and a reader writing every "/" in a name as the same character (the interoperability
  // tester's repair for FlowKit, oracle.py _slash_safe_copy) read the NOT as naming itself:
  // FlowKit, "NetworkXUnfeasible: Graph contains a cycle" (the sweep of this candidate, random-0009).
  it("gives a helper a name that does not look like a sibling's", () => {
    const b = new TreeBuilder();
    const slash = b.gate(box("CD8_pos/CD4", 0, 5000));
    b.pop("CD8_pos/CD4", [{ gate: slash, include: false }], b.root);
    const tree = b.tree();
    const { xml } = exportFlowJoWorkspace({ samples: [{ sample, fileName: "D1.fcs", ...tree }], now: new Date("2026-09-26T00:00:00Z"), producer: "GateLab test" });
    const names = [...xml.matchAll(/<(?:Population|NotNode|AndNode|OrNode) name="([^"]+)"/g)].map((m) => m[1]);
    expect(names).toContain("CD8_pos/CD4");
    const looks = names.map((n) => n.split("∕").join("/"));
    expect(new Set(looks).size).toBe(names.length);
    const dependents = [...xml.matchAll(/<Dependent name="([^"]+)"/g)].map((m) => m[1].split("∕").join("/"));
    expect(dependents.filter((d) => d === "CD8_pos/CD4")).toEqual([]);
  });

  // A quadrant gate whose four panels came back from Gating-ML as biex polygons of 5,000 to 6,600
  // vertices each made "Export FlowJo workspace" fail with "Maximum call stack size exceeded"
  // (FR-FCM-Z2HV and FR-FCM-Z282, both formats; the release candidate's verifier): a subtree's lines,
  // four a vertex, were appended with push(...lines), one argument a line, and past about 120,000
  // lines that is more than V8 takes. The Gating-ML export appended a polygon's lines the same way,
  // which a polygon of more than about 30,000 vertices reached.
  const circle = (n: number, cx: number, cy: number, r: number): Vertex[] =>
    Array.from({ length: n }, (_, k): Vertex => [cx + r * Math.cos((2 * Math.PI * k) / n), cy + r * Math.sin((2 * Math.PI * k) / n)]);
  // About 6 s alone, most of it jsdom's removeChild, which walks its parent's children each time
  // (restoreGateLabPolygon replaces 40,000 vertices); a browser's does not.
  it("writes a subtree of more lines than a call takes arguments, and reads it back", { timeout: 120000 }, () => {
    const b = new TreeBuilder();
    const big = b.gate(box("Big box", 0, 25000));
    const cells = b.pop("Cells", [{ gate: big }], b.root);
    const names: string[] = [];
    for (let k = 0; k < 8; k++) {
      const round = b.gate({ ...newGate(`Round ${k}`, "polygon", x, y, circle(5000, 6000 + 1000 * k, 10000, 3000)), space: "raw" as const } as Gate);
      names.push(`Round_${k}`);
      b.pop(`Round_${k}`, [{ gate: round }], cells);
    }
    const tree = b.tree();
    const before = evaluate(sample, tree);
    for (const name of names) expect(count(before.get(name)!), name).toBeGreaterThan(10);
    const { masks: after, xml } = roundTrip({ sample, fileName: "D1.fcs", ...tree }, read());
    expect(xml.match(/<gating:vertex>/g)?.length).toBe(40000);
    for (const name of ["Cells", ...names]) expect(moved(before.get(name)!, lookup(after, tree, name)!), name).toBe(0);
  });

  it("writes a Gating-ML polygon of more lines than a call takes arguments, and reads it back", () => {
    const b = new TreeBuilder();
    const round = b.gate({ ...newGate("Round", "polygon", x, y, circle(40000, 10000, 10000, 6000)), space: "raw" as const } as Gate);
    b.pop("Round_cells", [{ gate: round }], b.root);
    const tree = b.tree();
    const before = evaluate(sample, tree).get("Round_cells")!;
    expect(count(before)).toBeGreaterThan(50);
    for (const format of ["standard", "cytobank"] as const) {
      const xml = exportGatingML({ sample, ...tree, format });
      expect(xml.match(/<gating:vertex>/g)?.length, format).toBeGreaterThanOrEqual(40000);
      const pnn: Record<string, string> = {};
      for (const c of sample.channels) pnn[c.pnn] = c.key;
      const res = importGatingML(xml, sample.channels.map((c) => c.key), pnn, sample.instrument);
      const back = evaluate(read(), { gates: res.gates, gate_order: res.gate_order, populations: res.populations, root_population_id: res.root_population_id });
      expect(moved(before, back.get("Round_cells")!), format).toBe(0);
    }
  });

  // A GateLab tree with several populations at its root, intersections among them, went to FlowJo
  // as several top-level elements (each root population, and each intersection's helpers beside
  // it), which the importer read as that many independent trees: "20 gates · 15 trees" on the
  // public Bodenmiller bundle, and a single-file open imported one of them, refusing an
  // intersection whose operand was "in another of this sample's trees" (the release candidate's
  // browser verifier; 11 top-level ISAC gates on one file came back as 1 of 11 trees).
  it("reopens as the one tree it was, with populations and intersections at its root, helpers hidden", () => {
    const b = new TreeBuilder();
    const big = b.gate(box("Big box", 0, 15000));
    const small = b.gate(box("Small box", 0, 5000));
    const corner = b.gate(box("Corner", 12000, 30000));
    const low = b.pop("CD3_low", [{ gate: small }], b.root);
    b.pop("B_like", [{ gate: big }, { gate: small, include: false }], b.root);
    b.pop("T_like", [{ gate: big }, { gate: corner }], b.root);
    b.pop("Corner_cells", [{ gate: corner }], b.root);
    b.pop("Inner", [{ gate: corner, include: false }], low);
    const tree = b.tree();
    const before = evaluate(sample, tree);
    const { xml } = exportFlowJoWorkspace({ samples: [{ sample, fileName: "D1.fcs", ...tree }], now: new Date("2026-09-25T00:00:00Z"), producer: "GateLab test" });
    // Several top-level elements, helpers among them.
    expect(xml).toMatch(/gatelabOperand="1"/);
    const [summary] = listFlowJoWorkspaceSamples(xml);
    expect(summary.rootCount).toBe(1);
    expect(summary.trees).toHaveLength(1);
    expect(summary.trees[0].populations).toEqual(["CD3_low", "Inner", "B_like", "T_like", "Corner_cells"]);
    expect(summary.trees[0].gateCount).toBe(5);
    expect(summary.gateCount).toBe(5);
    expect(summary.trees[0].rootCount).toBe(n);
    // The one tree, chosen as a single-file open chooses it.
    const conv = flowJoWorkspaceToGatingML(xml, 0, 0, undefined, { flowJoGrid: false });
    expect(conv.warnings.join(" ")).not.toMatch(/independent gating trees|another of this sample's trees/);
    const fresh = read();
    const pnn: Record<string, string> = {};
    for (const c of fresh.channels) pnn[c.pnn] = c.key;
    const res = importGatingML(conv.gatingMl, fresh.channels.map((c) => c.key), pnn, fresh.instrument);
    const names = Object.values(res.populations).map((p) => p.name).sort();
    expect(names).toEqual(["All Events", "B_like", "CD3_low", "Corner_cells", "Inner", "T_like"]);
    const after = evaluate(fresh, { gates: res.gates, gate_order: Object.keys(res.gates), populations: res.populations, root_population_id: res.root_population_id });
    for (const name of ["CD3_low", "B_like", "T_like", "Corner_cells", "Inner"]) {
      expect(count(before.get(name)!), name).toBeGreaterThan(0);
      expect(moved(before.get(name)!, after.get(name)!), name).toBe(0);
    }
    // FlowJo's own workspace, the same elements without GateLab's mark, is FlowJo's trees.
    const [flowjo] = listFlowJoWorkspaceSamples(xml.replace(/ gatelabTree="1"/, ""));
    expect(flowjo.trees.length).toBeGreaterThan(1);
  });
});

// FlowJo writes "/" in a parameter name as "_" in a workspace, in a gate's dimensions, the
// Transformations and the spillover matrix alike (Sample.externalSpilloverPreview). The export
// kept the "/", so a reader that loads the file's parameters under FlowJo's names found no
// parameter "APC/Fire-A" and could evaluate no gate on it (FlowKit, the interoperability tester's
// fail:flowjo-parameter-name: 207 checks in the release candidate's sweep, 66 on 0.8.3).
describe("FlowJo export of a parameter named with a \"/\"", () => {
  const n = 400;
  const col = (f: (i: number) => number) => new Float32Array(n).map((_, i) => f(i));
  const fsc = col((i) => 1000 + (i % 20) * 1000);
  const ssc = col((i) => 1000 + Math.floor(i / 20) * 1000);
  const apc = col((i) => 50 + ((i * 37) % 400) * 25);
  const pe = col((i) => 80 + ((i * 53) % 400) * 20);
  const spill = "2,APC/Fire-A,PE-A,1,0.08,0.03,1";
  const read = (names: [string, string]) => {
    const bytes = writeFcs([fsc, ssc, apc, pe], [
      { name: "FSC-A", desc: "" }, { name: "SSC-A", desc: "" }, { name: names[0], desc: "CD3" }, { name: names[1], desc: "CD4" },
    ], { keywords: [["$SPILLOVER", spill.replace("APC/Fire-A", names[0]).replace("PE-A", names[1])]] });
    return new Sample(parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
  };
  const strategy = (sample: Sample) => {
    const [f, s, a, p] = sample.channels.map((c) => c.key);
    const b = new TreeBuilder();
    const cells = b.gate({ ...newGate("Cells", "polygon", f, a, [[2000, 1000], [15000, 1500], [16000, 8000], [3000, 9000]]), space: "raw" as const } as Gate);
    const box = b.gate({ ...newGate("CD4 box", "rectangle", a, p, [[2000, 1000], [7000, 6000]]), space: "raw" as const, bounds: "closed" as const } as Gate);
    const scatter = b.gate({ ...newGate("Scatter", "rectangle", f, s, [[0, 0], [14000, 14000]]), space: "raw" as const, bounds: "closed" as const } as Gate);
    const top = b.pop("Cells", [{ gate: cells }], b.root);
    b.pop("CD4_positive", [{ gate: box }], top);
    b.pop("Not_box", [{ gate: scatter }, { gate: box, include: false }], top);
    return b.tree();
  };

  it("writes it as FlowJo does, with \"_\", in every gate, axis and matrix, and reads back the same events", () => {
    const sample = read(["APC/Fire-A", "PE-A"]);
    expect(sample.hasCompensation).toBe(true);
    sample.setCompensation(true);
    const tree = strategy(sample);
    const before = evaluate(sample, tree);
    const fresh = read(["APC/Fire-A", "PE-A"]);
    const { masks: after, xml, warnings } = roundTrip({ sample, fileName: "D1.fcs", ...tree }, fresh);
    const named = [...xml.matchAll(/data-type:(?:name|parameter)="([^"]*)"/g)].map((m) => m[1]);
    expect(named).toContain("Comp-APC_Fire-A");
    expect(named).toContain("APC_Fire-A");
    expect(named.filter((name) => name.includes("/"))).toEqual([]);
    expect(xml).toMatch(/<transforms:spillover data-type:parameter="APC_Fire-A"/);
    expect(warnings.join(" ")).not.toContain('keeps its "/"');
    // The file's own keywords are the file's.
    expect(xml).toContain('value="APC/Fire-A"');
    for (const name of ["Cells", "CD4_positive", "Not_box"]) {
      expect(count(before.get(name)!), name).toBeGreaterThan(0);
      expect(moved(before.get(name)!, lookup(after, tree, name)!), name).toBe(0);
    }
  });

  it("keeps the \"/\" where the \"_\" form names another parameter of the file, and says so", () => {
    const sample = read(["APC/Fire-A", "APC_Fire-A"]);
    const tree = strategy(sample);
    const { xml, warnings } = exportFlowJoWorkspace({ samples: [{ sample, fileName: "D1.fcs", ...tree }], now: new Date("2026-09-26T00:00:00Z"), producer: "GateLab test" });
    const named = new Set([...xml.matchAll(/data-type:name="([^"]*)"/g)].map((m) => m[1]));
    expect(named.has("APC/Fire-A")).toBe(true);
    expect(named.has("APC_Fire-A")).toBe(true);
    expect(warnings.join(" ")).toContain('APC/Fire-A keeps its "/" in the workspace');
  });
});

// A curled quadrant whose arms cross: both arms curl into the upper right and meet at X, beyond
// which the region between them is quadrant 4 to GateLab (left of the vertical arm, below the
// horizontal one; gateMaskQuadrant), and the region between them before X is quadrant 2. Written as
// four polygons as if the arms did not cross, that region beyond X went to quadrant 2 and none of it
// to quadrant 4 (the interoperability sweep's fail:curly-quadrant-export, random-0016 "T cells",
// random-0052 "CD3-" and every population beneath it). Synthetic names and events.
describe("FlowJo export of a curled quadrant whose arms cross", () => {
  const side = 100;
  const n = side * side;
  const fsc = new Float32Array(n).map((_, i) => 5 + 10 * (i % side));
  const ssc = new Float32Array(n).map((_, i) => 5 + 10 * Math.floor(i / side));
  const bytes = writeFcs([fsc, ssc], [{ name: "FSC-A", desc: "" }, { name: "SSC-A", desc: "" }]);
  const read = () => new Sample(parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));

  it("writes each quadrant as the region GateLab holds, the region between the arms beyond X in quadrant 4", () => {
    const sample = read();
    const [x, y] = [sample.channels[0].key, sample.channels[1].key];
    const b = new TreeBuilder();
    const quad = b.gate({ ...newQuadrantGate("Curled", x, y, [300, 300]), curl: { power: 1.5, kx: 0.05, ky: 0.05 } } as Gate);
    for (const q of [1, 2, 3, 4]) b.pop(`Curled_Q${q}`, [{ gate: quad, quadrant: q }], b.root);
    const tree = b.tree();
    const before = evaluate(sample, tree);
    // Quadrant 4 holds events beyond the crosshair, between the crossed arms.
    const q4 = before.get("Curled_Q4")!;
    let between = 0;
    for (let i = 0; i < n; i++) if (q4[i] && (fsc[i] > 300 || ssc[i] > 300)) between++;
    expect(between).toBeGreaterThan(100);
    const { masks: after } = roundTrip({ sample, fileName: "D1.fcs", ...tree }, read());
    for (const q of [1, 2, 3, 4]) {
      const name = `Curled_Q${q}`;
      const held = before.get(name)!;
      expect(count(held), name).toBeGreaterThan(0);
      // The arms are traced in samples, within the densification band of each.
      expect(moved(held, lookup(after, tree, name)!), name).toBeLessThanOrEqual(Math.ceil(n * 0.005));
    }
  });
});

// A quadrant's four polygons share their edges on the dividers, and GateLab puts an event exactly on
// a divider on its upper or right side, so a reader holding a polygon's edge put it in two quadrants.
// And a quadrant's box, which reaches past the declared axis and past every event so that FlowJo's
// clamp keeps each event in one of the four, was pinned to the axis's end through the display: on
// FlowJo's 4096-channel biex table the top of a 262,144 axis went out as 261,622, and an event beyond
// it, which FlowJo moves onto the top, fell outside every quadrant (the interoperability sweep's
// corpus-quadrants "Q3", FL1-A at 352,568). Synthetic names and events.
describe("FlowJo export of a quadrant's dividers and box", () => {
  const vals = [-400, -20, 150, 193.5, 800, 5000, 90000, 262144, 352568];
  const fl1 = Float32Array.from(vals.flatMap((v) => vals.map(() => v)));
  const fl2 = Float32Array.from(vals.flatMap(() => vals));
  const bytes = writeFcs([fl1, fl2], [{ name: "FL1-A", desc: "CD3" }, { name: "FL2-A", desc: "CD4" }]);
  const read = () => new Sample(parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
  const biex = { kind: "biex" as const, maxValue: 262144, pos: 4.418539922, neg: 0, widthBasis: -10, channelRange: 256 };

  it("writes the box where it lies and each divider edge inside its quadrant, and reads back every quadrant exactly", () => {
    const sample = read();
    const [x, y] = [sample.channels[0].key, sample.channels[1].key];
    const b = new TreeBuilder();
    // A gate on FlowJo's biex declares both channels on it, 262,144 at the top.
    const onBiex = b.gate({ ...newGate("On biex", "rectangle", x, y, [[0.2, 0.2], [0.8, 0.8]]), space: "display", transforms: { [x]: biex, [y]: biex }, bounds: "closed" } as Gate);
    b.pop("On_biex", [{ gate: onBiex }], b.root);
    const quad = b.gate(newQuadrantGate("Quad", x, y, [800, 193.5]));
    for (const q of [1, 2, 3, 4]) b.pop(`Quad_Q${q}`, [{ gate: quad, quadrant: q }], b.root);
    const tree = b.tree();
    const before = evaluate(sample, tree);
    const { xml } = exportFlowJoWorkspace({ samples: [{ sample, fileName: "D1.fcs", ...tree }], now: new Date("2026-09-26T00:00:00Z"), producer: "GateLab test" });
    const ring = (q: number): Vertex[] => {
      const el = xml.match(new RegExp(`<Population name="Quad_Q${q}"[^>]*>[\\s\\S]*?</gating:PolygonGate>`))![0];
      const v = [...el.matchAll(/data-type:value="([^"]+)"/g)].map((m) => Number(m[1]));
      return v.flatMap((_, i) => (i % 2 ? [] : [[v[i], v[i + 1]] as Vertex]));
    };
    // The box reaches past the largest value on each channel, not to the table's pinned top.
    for (const q of [2, 3]) expect(Math.max(...ring(q).map((p) => p[0])), `Q${q}`).toBeGreaterThanOrEqual(352568);
    for (const q of [1, 2]) expect(Math.max(...ring(q).map((p) => p[1])), `Q${q}`).toBeGreaterThanOrEqual(352568);
    // Below and left of a divider, the edge lies between the divider and the nearest value below it.
    for (const q of [3, 4]) {
      const top = Math.max(...ring(q).map((p) => p[1]));
      expect(top, `Q${q} top`).toBeLessThan(193.5);
      expect(top, `Q${q} top`).toBeGreaterThan(150);
    }
    for (const q of [1, 4]) {
      const right = Math.max(...ring(q).map((p) => p[0]));
      expect(right, `Q${q} right`).toBeLessThan(800);
      expect(right, `Q${q} right`).toBeGreaterThan(150);
    }
    // Read back, every event in the quadrant GateLab puts it in, those on a divider and beyond the axis included.
    const fresh = read();
    const after = evaluate(fresh, importWorkspace(xml, fresh));
    for (const q of [1, 2, 3, 4]) {
      const name = `Quad_Q${q}`;
      expect(count(before.get(name)!), name).toBeGreaterThan(0);
      expect(moved(before.get(name)!, lookup(after, tree, name)!), name).toBe(0);
    }
  });
});

// A channel a floored log gate is on, declared otherwise because another gate on it reaches below
// the log's offset (logMisreadsOtherGates), still carries the log gates as GateLab holds them: a
// polygon whose edge lies on the floor holds every event GateLab puts there through a skirt below
// that edge, and a rectangle wholly below the floor, which holds no event, goes out below every
// event (the interoperability sweep's random-0097, a flog polygon on Ce140Di beside a raw range from
// 0 to 1, and random-0026, a flog range below the floor beside a quadrant at 0). Synthetic names and
// events.
describe("FlowJo export of floored log gates on a channel declared otherwise", () => {
  const fsc = Float32Array.from([30, 30, 30, 30, 30, 30, 60, 60]);
  const fl = Float32Array.from([-40, 0, 0.5, 2, 50, 5000, 0, 50]);
  const bytes = writeFcs([fsc, fl], [{ name: "FSC-A", desc: "" }, { name: "FL1-A", desc: "CD4" }]);
  const read = () => new Sample(parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
  const flog = { kind: "flog" as const, T: 10000, M: 4 };

  it("skirts a polygon on the floor and writes a rectangle below the floor where no event lies, as GateLab holds each", () => {
    const sample = read();
    const [x, y] = [sample.channels[0].key, sample.channels[1].key];
    const b = new TreeBuilder();
    const floorShape = b.gate({
      ...newGate("Floor shape", "polygon", x, y, [[20, 0], [45, 0], [45, 0.5], [20, 0.5]]),
      space: "display", transforms: { [x]: { kind: "identity" }, [y]: flog },
    } as Gate);
    b.pop("Floor_shape", [{ gate: floorShape }], b.root);
    const below = b.gate({
      ...newGate("Below floor", "rectangle", y, y, [[-1e9, -1e9], [-0.2, -0.2]]),
      space: "display", transforms: { [y]: flog }, bounds: "half-open",
    } as Gate);
    b.pop("Below_floor", [{ gate: below }], b.root);
    const drawn = b.gate({ ...newGate("Drawn", "rectangle", x, y, [[0, 0], [100, 1]]), space: "raw" as const, bounds: "half-open" } as Gate);
    b.pop("Drawn_cells", [{ gate: drawn }], b.root);
    const tree = b.tree();
    const before = evaluate(sample, tree);
    expect(Array.from(before.get("Floor_shape")!)).toEqual([1, 1, 1, 1, 1, 0, 0, 0]);
    expect(count(before.get("Below_floor")!)).toBe(0);
    expect(Array.from(before.get("Drawn_cells")!)).toEqual([0, 1, 1, 0, 0, 0, 1, 0]);
    const { xml } = exportFlowJoWorkspace({ samples: [{ sample, fileName: "D1.fcs", ...tree }], now: new Date("2026-09-26T00:00:00Z"), producer: "GateLab test" });
    expect(xml).not.toMatch(/<transforms:log [^>]*>\s*<data-type:parameter data-type:name="FL1-A"/);
    // FlowJo's reading: GateLab's records taken out, the importer's FlowJo rule on.
    const bare = xml.replace(/ gatelab(?:Rectangle|Polygon)="[^"]*"/g, "");
    const fresh = read();
    const flowJo = evaluate(fresh, importWorkspace(bare, fresh, 0, { flowJoGrid: false }));
    for (const name of ["Floor_shape", "Below_floor", "Drawn_cells"]) {
      expect(moved(before.get(name)!, flowJo.get(name)!), name).toBe(0);
    }
  });
});

// A quadrant on a floored log, on a channel another gate declares on FlowJo's biex: its box, placed
// below the floor in the gate's own space, was a positive value just below the log's offset in raw
// values, and every event below that, on the floor and in a lower quadrant to GateLab, fell outside
// all four for FlowJo (the interoperability sweep's random-0139 "CD3−", SSC-A on flog beside a biex
// ellipse). Synthetic names and events.
describe("FlowJo export of a quadrant on a floored log, on a channel declared otherwise", () => {
  const fsc = Float32Array.from([30, 30, 30, 60, 60, 60, 30, 60]);
  const fl = Float32Array.from([-40, 0, 0.5, -40, 0, 0.5, 5000, 5000]);
  const bytes = writeFcs([fsc, fl], [{ name: "FSC-A", desc: "" }, { name: "FL1-A", desc: "CD4" }]);
  const read = () => new Sample(parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
  const flog = { kind: "flog" as const, T: 10000, M: 4 };
  const biex = { kind: "biex" as const, maxValue: 262144, pos: 4.418539922, neg: 0, widthBasis: -10, channelRange: 256 };

  it("reaches below every event, and FlowJo's reading puts each event in the quadrant GateLab does", () => {
    const sample = read();
    const [x, y] = [sample.channels[0].key, sample.channels[1].key];
    const b = new TreeBuilder();
    const onBiex = b.gate({ ...newGate("On biex", "rectangle", y, y, [[0.2, 0.2], [0.8, 0.8]]), space: "display", transforms: { [y]: biex }, bounds: "closed" } as Gate);
    b.pop("On_biex", [{ gate: onBiex }], b.root);
    const quad = b.gate({ ...newQuadrantGate("Quad", x, y, [45, 0.5]), space: "display", transforms: { [x]: { kind: "identity" }, [y]: flog } } as Gate);
    for (const q of [1, 2, 3, 4]) b.pop(`Quad_Q${q}`, [{ gate: quad, quadrant: q }], b.root);
    const tree = b.tree();
    const before = evaluate(sample, tree);
    expect(Array.from(before.get("Quad_Q4")!)).toEqual([1, 1, 1, 0, 0, 0, 0, 0]);
    expect(Array.from(before.get("Quad_Q3")!)).toEqual([0, 0, 0, 1, 1, 1, 0, 0]);
    const { xml } = exportFlowJoWorkspace({ samples: [{ sample, fileName: "D1.fcs", ...tree }], now: new Date("2026-09-26T00:00:00Z"), producer: "GateLab test" });
    expect(declaredBiex(xml, "FL1-A")).not.toBeNull();
    const fresh = read();
    const after = evaluate(fresh, importWorkspace(xml, fresh));
    for (const q of [1, 2, 3, 4]) {
      const name = `Quad_Q${q}`;
      expect(moved(before.get(name)!, lookup(after, tree, name)!), name).toBe(0);
    }
  });
});

// A half-open rectangle's upper bound goes to FlowJo just below its edge, for FlowJo's closed rule,
// and FlowJo compares a rectangle's bounds in raw values; but on an axis whose display cannot tell
// the moved bound from the edge (0 moved to -1e-300 on an ArcSinh or biex axis), a reader comparing
// in the display held every event on the edge (the interoperability sweep's random-0026 " lead space",
// 2,503 zeros). The bound goes halfway to the nearest value below the edge instead, where both
// readings agree. Synthetic names and events.
describe("FlowJo export of a half-open bound the declared display cannot tell from its edge", () => {
  const fsc = Float32Array.from([50000, 50000, 50000, 50000, 50000]);
  const fl = Float32Array.from([-30, -20, 0, 0, 500]);
  const bytes = writeFcs([fsc, fl], [{ name: "FSC-A", desc: "" }, { name: "FL1-A", desc: "CD4" }]);
  const read = () => new Sample(parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));

  it("writes it halfway to the nearest value below the edge, where the display tells them apart", () => {
    const sample = read();
    const [x, y] = [sample.channels[0].key, sample.channels[1].key];
    const b = new TreeBuilder();
    const neg = b.gate({ ...newGate("Negative", "rectangle", x, y, [[0, -100], [100000, 0]]), space: "raw" as const, bounds: "half-open" } as Gate);
    b.pop("Negative_cells", [{ gate: neg }], b.root);
    const tree = b.tree();
    const before = evaluate(sample, tree).get("Negative_cells")!;
    expect(Array.from(before)).toEqual([1, 1, 0, 0, 0]);
    const { xml } = exportFlowJoWorkspace({ samples: [{ sample, fileName: "D1.fcs", ...tree }], now: new Date("2026-09-26T00:00:00Z"), producer: "GateLab test" });
    const decl = declaredBiex(xml, "FL1-A")!;
    expect(decl).not.toBeNull();
    const dim = xml.match(/<gating:dimension gating:min="([^"]+)" gating:max="([^"]+)">\s*<data-type:fcs-dimension data-type:name="FL1-A"/)!;
    const max = Number(dim[2]);
    expect(max).toBeLessThan(0);
    expect(max).toBeGreaterThan(-20);
    const t = biexTransform({ maxValue: decl.maxRange, pos: 4.5, neg: 0, widthBasis: decl.width, channelRange: 256 });
    expect(t.forward(max)).toBeLessThan(t.forward(0));
    const fresh = read();
    const flowJo = evaluate(fresh, importWorkspace(xml.replace(/ gatelabRectangle="[^"]*"/g, ""), fresh, 0, { flowJoGrid: true }));
    expect(moved(before, flowJo.get("Negative_cells")!)).toBe(0);
  });
});

// A channel a gate was drawn on in biex was declared on that biex, whose table on FlowJo's 4096
// channels begins at -132 (width -10, 262,144 top), and FlowJo moves every event below that onto it
// before it tests any gate. A raw ellipse beside it reaching -2,500 then held, for FlowJo, events it
// does not reach (the interoperability sweep's corpus-transform-zoo "ellipse raw", 578 events, and
// random-0042, 0112 and 0142, fail:flowjo-axis-range). The biex is widened until it reaches every
// gate, and the gate drawn on it, which GateLab evaluates with every event below its own table's
// first entry on that entry, is cut there and skirted below. Synthetic names and events.
describe("FlowJo export of a biex another gate on the channel reaches below", () => {
  const fl = Float32Array.from([-3000, -2000, -1500, -800, -400, -200, -120, -50, 0, 50, 400, 5000]);
  const fsc = new Float32Array(fl.length).fill(50000);
  const bytes = writeFcs([fsc, fl], [{ name: "FSC-A", desc: "" }, { name: "FL1-A", desc: "CD4" }]);
  const read = () => new Sample(parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
  const biex = { kind: "biex" as const, maxValue: 262144, pos: 4.418539922, neg: 0, widthBasis: -10, channelRange: 256 };

  function build(sample: Sample): Tree {
    const [x, y] = [sample.channels[0].key, sample.channels[1].key];
    const b = new TreeBuilder();
    const box = b.gate({
      ...newGate("Biex box", "polygon", x, y, [[20000, -5], [90000, -5], [90000, 60], [20000, 60]]),
      space: "display", transforms: { [x]: { kind: "identity" }, [y]: biex },
    } as Gate);
    b.pop("Biex_box", [{ gate: box }], b.root);
    const ellipse = b.gate({
      gate_id: "ellipse-1", name: "Raw ellipse", gate_type: "ellipse", x_channel: x, y_channel: y,
      mean: [50000, -1000], covariance: [[9e8, 0], [0, 2.25e6]], distance_square: 1, space: "raw",
      color: "#000000", label_offset: null,
    } as Gate);
    b.pop("Raw_ellipse", [{ gate: ellipse }], b.root);
    return b.tree();
  }

  it("widens the biex to reach the ellipse, and FlowJo's reading holds each gate's events as GateLab does", () => {
    const sample = read();
    const tree = build(sample);
    const before = evaluate(sample, tree);
    // GateLab: the biex box holds every event below its table's first entry (-93.5) on that entry;
    // the raw ellipse reaches from -2,500 to 500.
    expect(Array.from(before.get("Biex_box")!)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0]);
    expect(Array.from(before.get("Raw_ellipse")!)).toEqual([0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0]);
    const { xml } = exportFlowJoWorkspace({ samples: [{ sample, fileName: "D1.fcs", ...tree }], now: new Date("2026-09-26T00:00:00Z"), producer: "GateLab test" });
    const declared = declaredBiex(xml, "FL1-A")!;
    expect(declared.width).toBeLessThan(-10);
    const t = biexTransform({ maxValue: declared.maxRange, pos: 4.418539922, neg: Number(xml.match(/<transforms:biex [^>]*transforms:neg="([^"]+)"[^>]*>\s*<data-type:parameter data-type:name="FL1-A"/)![1]), widthBasis: declared.width, channelRange: 256, tableChannels: FLOWJO_BIEX_TABLE_CHANNELS });
    expect(t.inverse(0)).toBeLessThan(-2500);
    // FlowJo's reading of the polygons, continuous in the declared display, which puts an event
    // below the table on its first entry: GateLab's records taken out.
    const bare = xml.replace(/ gatelabPolygon="[^"]*"/g, "");
    const fresh = read();
    const flowJo = evaluate(fresh, importWorkspace(bare, fresh, 0, { flowJoGrid: false }));
    for (const name of ["Biex_box", "Raw_ellipse"]) expect(moved(before.get(name)!, flowJo.get(name)!), name).toBe(0);
    // GateLab's own reading uses its record.
    const again = read();
    const back = evaluate(again, importWorkspace(xml, again, 0, { flowJoGrid: false }));
    for (const name of ["Biex_box", "Raw_ellipse"]) expect(moved(before.get(name)!, back.get(name)!), name).toBe(0);
  });
});

// A channel a gate needed on FlowJo's log (an ellipse on it) kept the log, and a rectangle on raw
// values beside it with a bound below the log's offset held, for FlowJo, every event below the
// offset (random-0040 "A&B", a lower bound at -175 beside an ellipse on the log, 18 events). The
// ellipse now goes out on the channel's other axis, cut at the log's floor and skirted below it, as
// GateLab holds it, and the log is kept for no gate that way. Synthetic names and events.
describe("FlowJo export of an ellipse on FlowJo's log beside a gate reaching below its offset", () => {
  const fl = Float32Array.from([-500, -200, -100, -50, 0.5, 5, 50, 500, 5000]);
  const fsc = new Float32Array(fl.length).fill(50000);
  const bytes = writeFcs([fsc, fl], [{ name: "FSC-A", desc: "" }, { name: "FL1-A", desc: "CD4" }]);
  const read = () => new Sample(parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
  const wsplog = { kind: "wsplog" as const, offset: 1, decades: 5.418539922 };

  it("writes the ellipse cut at the floor on the other axis, and FlowJo's rule reads both gates as GateLab holds them", () => {
    const sample = read();
    const [x, y] = [sample.channels[0].key, sample.channels[1].key];
    const b = new TreeBuilder();
    const ellipse = b.gate({
      gate_id: "ellipse-log", name: "Log ellipse", gate_type: "ellipse", x_channel: x, y_channel: y,
      mean: [50000, 0.1], covariance: [[9e8, 0], [0, 0.09]], distance_square: 1, space: "display",
      transforms: { [x]: { kind: "identity" }, [y]: wsplog }, color: "#000000", label_offset: null,
    } as Gate);
    b.pop("Log_ellipse", [{ gate: ellipse }], b.root);
    const drawn = b.gate({ ...newGate("Drawn", "rectangle", x, y, [[0, -150], [100000, 1000]]), space: "raw" as const, bounds: "closed" } as Gate);
    b.pop("Drawn_cells", [{ gate: drawn }], b.root);
    const tree = b.tree();
    const before = evaluate(sample, tree);
    expect(Array.from(before.get("Log_ellipse")!)).toEqual([1, 1, 1, 1, 1, 1, 1, 0, 0]);
    expect(Array.from(before.get("Drawn_cells")!)).toEqual([0, 0, 1, 1, 1, 1, 1, 1, 0]);
    const { xml } = exportFlowJoWorkspace({ samples: [{ sample, fileName: "D1.fcs", ...tree }], now: new Date("2026-09-26T00:00:00Z"), producer: "GateLab test" });
    expect(xml).not.toMatch(/<transforms:log [^>]*>\s*<data-type:parameter data-type:name="FL1-A"/);
    const fresh = read();
    // Rectangles by FlowJo's rule (events beyond the declared axis on its end), polygons continuous.
    const rects = evaluate(fresh, importWorkspace(xml.replace(/ gatelabRectangle="[^"]*"/g, ""), fresh, 0, { flowJoGrid: true }));
    expect(moved(before.get("Drawn_cells")!, rects.get("Drawn_cells")!)).toBe(0);
    const again = read();
    const polys = evaluate(again, importWorkspace(xml.replace(/ gatelabPolygon="[^"]*"/g, ""), again, 0, { flowJoGrid: false }));
    expect(moved(before.get("Log_ellipse")!, polys.get("Log_ellipse")!)).toBe(0);
  });
});

// GateLab decides a gate on a display on its own float32 column of the display's values, and an
// event lying on an edge in double precision is on whichever side float32 rounding put it:
// float32(asinh(4)) lies below asinh(4), so a half-open rectangle whose upper edge is asinh(60 / 15)
// holds the events at 60, and one whose lower edge it is leaves them out. The FlowJo export moved the
// upper bound below 60 for FlowJo's closed rule and wrote the lower one at 60, and FlowJo read both
// the other way (the public S8 file's "Singlets / Q1: CD3− CD4+", 18 events at 192.0; random-0026
// "IFN-γ", a quadrant whose divider is asinh(4), 160 events at Event_length 60.0). Each bound, and a
// quadrant's shared edge, now goes where GateLab divides this file's events. Synthetic names and
// events.
describe("FlowJo export of an edge GateLab decides on its float32 display", () => {
  const fl = Float32Array.from([58, 59, 60, 60, 60, 61, 62, 63]);
  const fsc = new Float32Array(fl.length).fill(50000);
  const bytes = writeFcs([fsc, fl], [{ name: "FSC-A", desc: "" }, { name: "FL1-A", desc: "CD4" }]);
  const read = () => new Sample(parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
  const asinh15 = { kind: "asinh" as const, cofactor: 15 };
  const edge = Math.asinh(60 / 15);

  it("puts each bound on GateLab's side of the events at the edge, and FlowJo's rule reads them as GateLab does", () => {
    expect(Math.fround(edge)).toBeLessThan(edge);
    const sample = read();
    const [x, y] = [sample.channels[0].key, sample.channels[1].key];
    const b = new TreeBuilder();
    const upper = b.gate({
      ...newGate("Upper", "rectangle", x, y, [[0, Math.asinh(58.5 / 15)], [100000, edge]]),
      space: "display", transforms: { [x]: { kind: "identity" }, [y]: asinh15 }, bounds: "half-open",
    } as Gate);
    b.pop("Upper_cells", [{ gate: upper }], b.root);
    const lower = b.gate({
      ...newGate("Lower", "rectangle", x, y, [[0, edge], [100000, Math.asinh(62.5 / 15)]]),
      space: "display", transforms: { [x]: { kind: "identity" }, [y]: asinh15 }, bounds: "closed",
    } as Gate);
    b.pop("Lower_cells", [{ gate: lower }], b.root);
    const quad = b.gate({ ...newQuadrantGate("Quad", x, y, [25000, edge]), space: "display", transforms: { [x]: { kind: "identity" }, [y]: asinh15 } } as Gate);
    b.pop("Q3_cells", [{ gate: quad, quadrant: 3 }], b.root);
    b.pop("Q2_cells", [{ gate: quad, quadrant: 2 }], b.root);
    const tree = b.tree();
    const before = evaluate(sample, tree);
    // GateLab: the events at 60 lie below the edge on its float32 column.
    expect(Array.from(before.get("Upper_cells")!)).toEqual([0, 1, 1, 1, 1, 0, 0, 0]);
    expect(Array.from(before.get("Lower_cells")!)).toEqual([0, 0, 0, 0, 0, 1, 1, 0]);
    expect(Array.from(before.get("Q3_cells")!)).toEqual([1, 1, 1, 1, 1, 0, 0, 0]);
    expect(Array.from(before.get("Q2_cells")!)).toEqual([0, 0, 0, 0, 0, 1, 1, 1]);
    const { xml } = exportFlowJoWorkspace({ samples: [{ sample, fileName: "D1.fcs", ...tree }], now: new Date("2026-09-26T00:00:00Z"), producer: "GateLab test" });
    // FlowJo's reading: GateLab's records taken out, FlowJo's closed rule on raw values.
    const fresh = read();
    const flowJo = evaluate(fresh, importWorkspace(xml.replace(/ gatelabRectangle="[^"]*"/g, ""), fresh, 0, { flowJoGrid: true }));
    for (const name of ["Upper_cells", "Lower_cells", "Q3_cells", "Q2_cells"]) expect(moved(before.get(name)!, flowJo.get(name)!), name).toBe(0);
    // GateLab's own reading, with its records.
    const again = read();
    const back = evaluate(again, importWorkspace(xml, again, 0, { flowJoGrid: true }));
    for (const name of ["Upper_cells", "Lower_cells", "Q3_cells", "Q2_cells"]) expect(moved(before.get(name)!, back.get(name)!), name).toBe(0);
  });
});

// A rectangle on a floored log wholly below its floor holds nothing in GateLab, and went out as a
// zero-width range below every event. On a channel declared biex, a reader that puts a value below
// the biex table on its first channel (FlowKit, the release candidate's verifier) put that bound
// there with every event below the table and held 786 events. It now goes where no event of the file
// lies inside the declared axis, and holds nothing by FlowJo's rule and by that reader's alike.
// Synthetic names and events.
describe("FlowJo export of a rectangle wholly below a floored log's floor, on a channel declared biex", () => {
  const n = 400;
  const fsc = new Float32Array(n);
  const fl = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    fsc[i] = (i * 37) % 100;
    fl[i] = i % 3 === 0 ? -60 + ((i * 7) % 61) : Math.round(10 ** (4 * ((i * 13) % 100) / 100));
  }
  const bytes = writeFcs([fsc, fl], [{ name: "FSC-A", desc: "" }, { name: "FL1-A", desc: "CD4" }]);
  const read = () => new Sample(parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));

  it("holds no event by FlowJo's rule, or where a reader pins a value below the table", () => {
    const sample = read();
    const [x, y] = [sample.channels[0].key, sample.channels[1].key];
    const flog = { kind: "flog" as const, T: 10000, M: 4 };
    const b = new TreeBuilder();
    const below = b.gate({
      ...newGate("Below", "rectangle", x, y, [[0, -0.5], [100, -0.1]]),
      space: "display", transforms: { [x]: { kind: "identity" }, [y]: flog }, bounds: "half-open",
    } as Gate);
    b.pop("Below_floor", [{ gate: below }], b.root);
    // A raw range reaching below the log's offset: the channel is declared biex, not the log.
    const range = b.gate({ ...newGate("Range", "rectangle", x, y, [[0, -20], [100, 0.5]]), space: "raw" as const, bounds: "half-open" } as Gate);
    b.pop("Raw_range", [{ gate: range }], b.root);
    const tree = b.tree();
    expect(count(evaluate(sample, tree).get("Below_floor")!)).toBe(0);
    const { xml } = exportFlowJoWorkspace({ samples: [{ sample, fileName: "D1.fcs", ...tree }], now: new Date("2026-09-26T00:00:00Z"), producer: "GateLab test" });
    const m = xml.match(/<transforms:biex ([^>]*)>\s*<data-type:parameter data-type:name="FL1-A"/)!;
    const attr = (k: string) => Number(m[1].match(new RegExp(`transforms:${k}="([^"]+)"`))![1]);
    const t = biexTransform({ maxValue: attr("maxRange"), pos: attr("pos"), neg: attr("neg"), widthBasis: attr("width"), channelRange: attr("length"), tableChannels: FLOWJO_BIEX_TABLE_CHANNELS });
    const rect = xml.match(/<Population name="Below_floor"[\s\S]*?<gating:RectangleGate[\s\S]*?<\/gating:RectangleGate>/)![0];
    const dim = rect.match(/<gating:dimension gating:min="([^"]+)" gating:max="([^"]+)">\s*<data-type:fcs-dimension data-type:name="FL1-A"/)!;
    const [lo, hi] = [Number(dim[1]), Number(dim[2])];
    const floor = t.inverse(0);
    let flowJo = 0;
    let pinned = 0;
    for (const v of fl) {
      const moved = Math.max(v, floor);
      if (moved >= lo && moved <= hi) flowJo++;
      const d = t.forward(v);
      if (d >= t.forward(lo) && d <= t.forward(hi)) pinned++;
    }
    expect(flowJo).toBe(0);
    expect(pinned).toBe(0);
  });
});

// A polygon or an ellipse on a floored log with nothing above its floor holds only the events GateLab
// places on the floor where its edge runs along it from below, and nothing where it lies wholly below.
// On a channel declared otherwise (here biex, for a raw range reaching below the log's offset), the
// export cut such a gate to nothing, found no ring left, and wrote it as drawn: raw values below the
// floor, where events lie that GateLab places on the floor, outside the gate. FlowKit held 43 events of
// such a polygon and 4 of such an ellipse where GateLab holds none (the release candidate's verifier,
// round after f534ba1). Synthetic names and events.
describe("FlowJo export of log gates with nothing above the floor, on a channel declared biex", () => {
  const n = 600;
  const fsc = new Float32Array(n);
  const fl = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    fsc[i] = (i * 37) % 100;
    const c = i % 4;
    fl[i] = c === 0 ? -60 + ((i * 7) % 61) : c === 1 ? (((i * 11) % 19) + 1) / 20 : c === 2 ? 1 : Math.round(10 ** ((4 * ((i * 13) % 100)) / 100));
  }
  const bytes = writeFcs([fsc, fl], [{ name: "FSC-A", desc: "" }, { name: "FL1-A", desc: "CD4" }]);
  const read = () => new Sample(parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
  const wsplog = { kind: "wsplog" as const, offset: 1, decades: 4 };
  /** Events strictly inside a written ring, in raw values: no event on an edge counts. */
  const strictlyInside = (ring: Vertex[]): number => {
    let held = 0;
    for (let i = 0; i < n; i++) {
      const [px, py] = [fsc[i], fl[i]];
      let inside = false;
      for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
        const [xa, ya] = ring[a];
        const [xb, yb] = ring[b];
        if ((ya > py) !== (yb > py) && px < xa + ((py - ya) * (xb - xa)) / (yb - ya)) inside = !inside;
      }
      if (inside) held++;
    }
    return held;
  };

  it("writes each where it holds what GateLab holds, and FlowJo's reading of the file agrees", () => {
    const sample = read();
    const [x, y] = [sample.channels[0].key, sample.channels[1].key];
    const onLog = { space: "display" as const, transforms: { [x]: { kind: "identity" as const }, [y]: wsplog } };
    const b = new TreeBuilder();
    const below = b.gate({ ...newGate("Poly below", "polygon", x, y, [[0, -0.6], [100, -0.6], [100, -0.01], [0, -0.01]]), ...onLog } as Gate);
    b.pop("Poly_below", [{ gate: below }], b.root);
    const ellipse = b.gate({
      gate_id: "ellipse-below", name: "Ellipse below", gate_type: "ellipse", x_channel: x, y_channel: y,
      mean: [50, -0.2], covariance: [[400, 0], [0, 0.01]], distance_square: 1, color: "#000000", label_offset: null, ...onLog,
    } as Gate);
    b.pop("Ellipse_below", [{ gate: ellipse }], b.root);
    const flogBelow = b.gate({
      ...newGate("Flog below", "polygon", x, y, [[10, -0.5], [90, -0.5], [60, -0.05]]),
      space: "display", transforms: { [x]: { kind: "identity" }, [y]: { kind: "flog", T: 10000, M: 4 } },
    } as Gate);
    b.pop("Flog_below", [{ gate: flogBelow }], b.root);
    // Its upper edge on the floor: GateLab holds every event it places there between 20 and 45.
    const touching = b.gate({ ...newGate("Poly on floor", "polygon", x, y, [[20, -0.6], [45, -0.6], [45, 0], [20, 0]]), ...onLog } as Gate);
    b.pop("Poly_on_floor", [{ gate: touching }], b.root);
    // Two edges on the floor, from 10 to 30 and from 70 to 90.
    const comb = b.gate({
      ...newGate("Comb on floor", "polygon", x, y, [[10, -0.6], [90, -0.6], [90, 0], [70, 0], [70, -0.3], [30, -0.3], [30, 0], [10, 0]]), ...onLog,
    } as Gate);
    b.pop("Comb_on_floor", [{ gate: comb }], b.root);
    const range = b.gate({ ...newGate("Range", "rectangle", x, y, [[0, -20], [100, 0.5]]), space: "raw" as const, bounds: "half-open" } as Gate);
    b.pop("Raw_range", [{ gate: range }], b.root);
    const tree = b.tree();
    const before = evaluate(sample, tree);
    expect(count(before.get("Poly_below")!)).toBe(0);
    expect(count(before.get("Ellipse_below")!)).toBe(0);
    expect(count(before.get("Flog_below")!)).toBe(0);
    const onFloor = (ranges: [number, number][]) => {
      let m = 0;
      for (let i = 0; i < n; i++) if (fl[i] <= 1 && ranges.some(([lo, hi]) => fsc[i] >= lo && fsc[i] <= hi)) m++;
      return m;
    };
    expect(count(before.get("Poly_on_floor")!)).toBe(onFloor([[20, 45]]));
    expect(count(before.get("Comb_on_floor")!)).toBe(onFloor([[10, 30], [70, 90]]));
    const { xml } = exportFlowJoWorkspace({ samples: [{ sample, fileName: "D1.fcs", ...tree }], now: new Date("2026-09-26T00:00:00Z"), producer: "GateLab test" });
    expect(declaredBiex(xml, "FL1-A")).not.toBeNull();
    // FlowJo's reading: GateLab's records taken out, polygons continuous on the declared axis.
    const fresh = read();
    const flowJo = evaluate(fresh, importWorkspace(xml.replace(/ gatelab(?:Rectangle|Polygon)="[^"]*"/g, ""), fresh, 0, { flowJoGrid: false }));
    // GateLab's own reading, with its records.
    const again = read();
    const back = evaluate(again, importWorkspace(xml, again, 0, { flowJoGrid: false }));
    const names = ["Poly_below", "Ellipse_below", "Flog_below", "Poly_on_floor", "Comb_on_floor"];
    for (const name of [...names, "Raw_range"]) {
      expect(moved(before.get(name)!, flowJo.get(name)!), name).toBe(0);
      expect(moved(before.get(name)!, back.get(name)!), name).toBe(0);
    }
    // No event lies on an edge of the written ring, so a reader that drops an edge holds the same.
    for (const name of names) {
      expect(strictlyInside(writtenPolygon(xml, name)!), name).toBe(count(before.get(name)!));
    }
  });
});

// FlowJo tests every PolygonGate that declares a gateResolution on its 256-channel grid
// (flowjoGrid.ts), and the export writes one on every polygon it draws, while GateLab holds such a
// gate continuously and reads it back from its record. The release candidate's verifier read the
// export at a799817 through GateLab's own grid import (the importer with GateLab's records taken out,
// "Evaluate gates as FlowJo does" on): a strip on a log floor, the band an empty gate goes to and an
// axis-aligned polygon were each read otherwise, at a few to 13,600 events (the public FACSCalibur
// file), with no warning. Synthetic names and events, and the public vendor files.
describe("FlowJo export of polygons FlowJo reads on its grid", () => {
  /** FlowJo's reading of a workspace: GateLab's records taken out, every polygon on the grid it declares. */
  const onGrid = (xml: string, fresh: Sample): Map<string, Uint8Array> =>
    evaluate(fresh, importWorkspace(xml.replace(/ gatelab(?:Rectangle|Polygon)="[^"]*"/g, ""), fresh, 0, { flowJoGrid: true }));
  /** A reader testing every polygon continuously on the declared axes, GateLab's records taken out. */
  const continuous = (xml: string, fresh: Sample): Map<string, Uint8Array> =>
    evaluate(fresh, importWorkspace(xml.replace(/ gatelab(?:Rectangle|Polygon)="[^"]*"/g, ""), fresh, 0, { flowJoGrid: false }));
  /** The kind of gate element a population is written with. */
  const element = (xml: string, name: string): string | undefined =>
    new RegExp(`<Population name="${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>[\\s\\S]*?<gating:(PolygonGate|RectangleGate|EllipsoidGate)\\b`).exec(xml)?.[1];
  /**
   * The count a warning names a gate with, or null where no warning names it: of its population's
   * parent's events in an export, of the file's in the preview (planFlowJoExport), which evaluates no
   * population.
   */
  const named = (warnings: string[], name: string): number | null => {
    const w = warnings.find((x) => x.startsWith(`"${name}" is a polygon, which FlowJo tests on its 256-channel grid`));
    const m = w ? /FlowJo reads (\d+) of (?:this file's \d+ events|the \d+ events of ")/.exec(w) : null;
    return m ? Number(m[1]) : null;
  };
  /**
   * A reader that holds a written RectangleGate half-open on the stored values, min ≤ v < max, as
   * FlowKit reads a workspace's rectangle; and every bound it states, with the channel's values.
   */
  const halfOpen = (xml: string, name: string, fresh: Sample): { mask: Uint8Array; bounds: Array<{ lo: number; hi: number; values: ArrayLike<number> }> } => {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const gate = new RegExp(`<Population name="${esc}"[^>]*>[\\s\\S]*?(<gating:RectangleGate\\b[\\s\\S]*?</gating:RectangleGate>)`).exec(xml)![1];
    const bounds = [...gate.matchAll(/<gating:dimension([^>]*)>\s*<data-type:fcs-dimension data-type:name="([^"]+)"/g)].map(([, attrs, pnn]) => {
      const lo = /gating:min="([^"]+)"/.exec(attrs);
      const hi = /gating:max="([^"]+)"/.exec(attrs);
      const index = fresh.channels.findIndex((c) => c.pnn === pnn);
      return { lo: lo ? Number(lo[1]) : -Infinity, hi: hi ? Number(hi[1]) : Infinity, values: fresh.rawColumnData(index) };
    });
    const n = bounds[0].values.length;
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = bounds.every((b) => b.values[i] >= b.lo && b.values[i] < b.hi) ? 1 : 0;
    return { mask, bounds };
  };
  /** Whether a written bound lies on a value of its channel, or an axis is one value. */
  const onAnEvent = (b: { lo: number; hi: number; values: ArrayLike<number> }): boolean =>
    b.lo === b.hi || Array.prototype.some.call(b.values, (v: number) => v === b.lo || v === b.hi);
  const lcg = (seed: number) => {
    let s = seed >>> 0;
    return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  };
  const wsplog = { kind: "wsplog" as const, offset: 1, decades: 4.5 };

  describe("gates with nothing above a log floor, on channels declared biex and linear", () => {
    const n = 6000;
    const r = lcg(11);
    const fsc = new Float32Array(n);
    const fl = new Float32Array(n);
    const ssc = new Float32Array(n);
    const scat = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      fsc[i] = Math.round(r() * 1000) / 10;
      const u = r();
      fl[i] = u < 0.3 ? (r() + r() + r() - 1.5) * 40 : u < 0.45 ? -3000 + r() * 2900 : u < 0.55 ? 1 : Math.pow(10, 4 * r());
      ssc[i] = Math.round(r() * 262144);
      const w = r();
      scat[i] = w < 0.2 ? Math.round(r() * 20) / 20 : w < 0.3 ? -Math.round(r() * 400) / 10 : Math.round(r() * 262144);
    }
    const bytes = writeFcs([fsc, fl, ssc, scat], [
      { name: "FSC-A", desc: "" }, { name: "FL1-A", desc: "CD4" }, { name: "SSC-A", desc: "" }, { name: "FSC-H", desc: "", range: 262144 },
    ]);
    const read = () => new Sample(parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
    const read_ = read;

    it("writes each where FlowJo's grid holds what GateLab holds, and names the comb it cannot", () => {
      const sample = read();
      const [x, y, s, h] = sample.channels.map((c) => c.key);
      const onLog = { space: "display" as const, transforms: { [x]: { kind: "identity" as const }, [y]: wsplog } };
      const b = new TreeBuilder();
      const add = (name: string, gate: Gate) => b.pop(name, [{ gate: b.gate(gate) }], b.root);
      // Its upper edge on the floor, from 20 to 45: GateLab holds the events it puts there.
      add("On_floor", { ...newGate("On floor", "polygon", x, y, [[20, -0.6], [45, -0.6], [45, 0], [20, 0]]), ...onLog } as Gate);
      // Not axis-aligned, meeting the floor along one edge.
      add("Floor_triangle", { ...newGate("Floor triangle", "polygon", x, y, [[55, 0], [85, 0], [70, -0.5]]), ...onLog } as Gate);
      add("Below_floor", { ...newGate("Below floor", "polygon", x, y, [[0, -0.6], [100, -0.6], [100, -0.01], [0, -0.01]]), ...onLog } as Gate);
      add("Ellipse_below", {
        gate_id: "ellipse-below-grid", name: "Ellipse below", gate_type: "ellipse", x_channel: x, y_channel: y,
        mean: [50, -0.3], covariance: [[400, 0], [0, 0.01]], distance_square: 1, color: "#000000", label_offset: null, ...onLog,
      } as Gate);
      // Two edges on the floor: no rectangle, and FlowJo's grid cannot hold it (below).
      add("Comb", { ...newGate("Comb", "polygon", x, y, [[10, -0.6], [90, -0.6], [90, 0], [70, 0], [70, -0.3], [30, -0.3], [30, 0], [10, 0]]), ...onLog } as Gate);
      // A raw range reaching below the log's offset: the channel is declared biex.
      add("Raw_range", { ...newGate("Raw range", "rectangle", x, y, [[0, -20], [100, 0.5]]), space: "raw", bounds: "half-open" } as Gate);
      // On a scatter channel: declared linear for the raw range beside it; the gate holds no event.
      add("Scatter_band", {
        ...newGate("Scatter band", "polygon", s, h, [[0, -0.6], [262144, -0.6], [262144, -0.05], [0, -0.05]]),
        space: "display", transforms: { [s]: { kind: "identity" }, [h]: wsplog },
      } as Gate);
      add("Scatter_range", { ...newGate("Scatter range", "rectangle", s, h, [[0, -50], [262144, 0.5]]), space: "raw", bounds: "half-open" } as Gate);
      const tree = b.tree();
      const before = evaluate(sample, tree);
      expect(count(before.get("On_floor")!)).toBeGreaterThan(0);
      expect(count(before.get("Floor_triangle")!)).toBeGreaterThan(0);
      expect(count(before.get("Below_floor")!)).toBe(0);
      expect(count(before.get("Scatter_band")!)).toBe(0);
      const entry = { sample, fileName: "D1.fcs", ...tree };
      const { xml, warnings } = exportFlowJoWorkspace({ samples: [entry], now: new Date("2026-09-26T00:00:00Z"), producer: "GateLab test" });
      expect(declaredBiex(xml, "FL1-A")).not.toBeNull();
      expect(xml).toMatch(/<transforms:linear [^>]*>\s*<data-type:parameter data-type:name="FSC-H"/);
      const grid = onGrid(xml, read());
      const flowKitLike = continuous(xml, read());
      const own = evaluate(read(), importWorkspace(xml, read(), 0, { flowJoGrid: true }));
      const ownOff = evaluate(read(), importWorkspace(xml, read(), 0, { flowJoGrid: false }));
      const exact = ["On_floor", "Floor_triangle", "Below_floor", "Ellipse_below", "Scatter_band"];
      for (const name of exact) {
        expect(element(xml, name), name).toBe("RectangleGate");
        expect(named(warnings, name.replace(/_/g, " ")), name).toBeNull();
        // Its bounds lie where no event does, never one value on an axis, so a half-open reader holds
        // what GateLab holds too. At 5473470 they lay on the events: the strip dropped the events on
        // its upper bound, and the triangle's apex made one axis a single value, which held none.
        const read = halfOpen(xml, name, read_());
        for (const b of read.bounds) expect(onAnEvent(b), `${name} bound ${b.lo}..${b.hi}`).toBe(false);
        expect(moved(before.get(name)!, read.mask), `${name} half-open`).toBe(0);
      }
      for (const name of [...exact, "Comb", "Raw_range", "Scatter_range"]) {
        if (name !== "Comb") expect(moved(before.get(name)!, grid.get(name)!), `${name} on FlowJo's grid`).toBe(0);
        expect(moved(before.get(name)!, flowKitLike.get(name)!), `${name} continuous`).toBe(0);
        expect(moved(before.get(name)!, own.get(name)!), `${name} as GateLab reads it`).toBe(0);
        expect(moved(before.get(name)!, ownOff.get(name)!), `${name} as GateLab reads it, grid off`).toBe(0);
      }
      // The comb holds events on the floor beside others on the channel above it: no move puts it on
      // the grid, so it goes out as it was and is named with the events FlowJo reads otherwise.
      expect(element(xml, "Comb")).toBe("PolygonGate");
      const combOff = moved(before.get("Comb")!, grid.get("Comb")!);
      expect(combOff).toBeGreaterThan(0);
      expect(named(warnings, "Comb")).toBe(combOff);
      // The export dialog's preview, which evaluates no population, says the same.
      expect(named(planFlowJoExport([entry]).warnings, "Comb")).toBe(combOff);
    });

    it("counts a named polygon's events within its population's parent, and the preview over the file", () => {
      const sample = read();
      const [x, y] = sample.channels.map((c) => c.key);
      const onLog = { space: "display" as const, transforms: { [x]: { kind: "identity" as const }, [y]: wsplog } };
      const b = new TreeBuilder();
      // The comb beneath a parent holding FSC-A 50 and above: some of the events FlowJo's grid reads
      // otherwise lie outside it.
      const parent = b.pop("Right_half", [{ gate: b.gate({ ...newGate("Right half", "rectangle", x, y, [[50, -1e9], [101, 1e9]]), space: "raw", bounds: "closed" } as Gate) }], b.root);
      b.pop("Comb", [{ gate: b.gate({ ...newGate("Comb", "polygon", x, y, [[10, -0.6], [90, -0.6], [90, 0], [70, 0], [70, -0.3], [30, -0.3], [30, 0], [10, 0]]), ...onLog } as Gate) }], parent);
      const tree = b.tree();
      const before = evaluate(sample, tree);
      const entry = { sample, fileName: "D1.fcs", ...tree };
      const { xml, warnings } = exportFlowJoWorkspace({ samples: [entry], now: new Date("2026-09-26T00:00:00Z"), producer: "GateLab test" });
      const grid = onGrid(xml, read());
      expect(moved(before.get("Right_half")!, grid.get("Right_half")!)).toBe(0);
      const inParent = moved(before.get("Comb")!, grid.get("Comb")!);
      const overFile = named(planFlowJoExport([entry]).warnings, "Comb")!;
      expect(inParent).toBeGreaterThan(0);
      expect(overFile).toBeGreaterThan(inParent);
      expect(named(warnings, "Comb")).toBe(inParent);
      expect(warnings.find((w) => w.startsWith('"Comb" is a polygon'))).toContain(`of the ${count(before.get("Right_half")!)} events of "Comb"'s parent`);
    });
  });

  describe("polygons drawn on raw scatter, one event or two on every channel", () => {
    // Every channel pair of FSC-A and SSC-A (declared linear from 0 to 256, one channel a unit) holds
    // the events at one integer point; FSC-H and SSC-H put one a quarter below it and one a quarter
    // above, in one channel.
    const n = 20000;
    const cols = [0, 1, 2, 3].map(() => new Float32Array(n));
    for (let i = 0; i < n; i++) {
      const [px, py] = [i % 100, Math.floor(i / 100) % 100];
      const q = i < n / 2 ? -0.25 : 0.25;
      cols[0][i] = px;
      cols[1][i] = py;
      cols[2][i] = px + q;
      cols[3][i] = py + q;
    }
    const bytes = writeFcs(cols, ["FSC-A", "SSC-A", "FSC-H", "SSC-H"].map((name) => ({ name, desc: "", range: 256 })));
    const read = () => new Sample(parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
    const lShape = (d: number): Vertex[] => [[20 + d, 20 + d], [60 + d, 20 + d], [60 + d, 50 + d], [40 + d, 50 + d], [40 + d, 80 + d], [20 + d, 80 + d]];

    it("moves a vertex across a channel boundary where that puts the polygon on FlowJo's grid, and names one it cannot", () => {
      const sample = read();
      const [fa, sa, fh, sh] = sample.channels.map((c) => c.key);
      const b = new TreeBuilder();
      // Its right and upper edges at .6 round onto the next channel, whose events lie outside it.
      const drawn = lShape(0.6);
      b.pop("L_shape", [{ gate: b.gate({ ...newGate("L shape", "polygon", fa, sa, drawn), space: "raw" } as Gate) }], b.root);
      // An axis-aligned polygon: a RectangleGate, which FlowJo does not grid.
      const box: Vertex[] = [[20.6, 20.6], [60.6, 20.6], [60.6, 50.6], [20.6, 50.6]];
      b.pop("Box", [{ gate: b.gate({ ...newGate("Box", "polygon", fa, sa, box), space: "raw" } as Gate) }], b.root);
      // Edges through the middle of channels holding an event either side: FlowJo's grid cannot hold it.
      const split = lShape(0);
      b.pop("Split", [{ gate: b.gate({ ...newGate("Split", "polygon", fh, sh, split), space: "raw" } as Gate) }], b.root);
      const tree = b.tree();
      const before = evaluate(sample, tree);
      const entry = { sample, fileName: "D2.fcs", ...tree };
      const { xml, warnings } = exportFlowJoWorkspace({ samples: [entry], now: new Date("2026-09-26T00:00:00Z"), producer: "GateLab test" });
      expect(xml).toMatch(/<transforms:linear transforms:minRange="0" transforms:maxRange="256" gain="1">\s*<data-type:parameter data-type:name="FSC-A"/);
      const grid = onGrid(xml, read());
      const flowKitLike = continuous(xml, read());
      const own = evaluate(read(), importWorkspace(xml, read(), 0, { flowJoGrid: true }));
      for (const name of ["L_shape", "Box", "Split"]) {
        expect(count(before.get(name)!), name).toBeGreaterThan(0);
        expect(moved(before.get(name)!, flowKitLike.get(name)!), `${name} continuous`).toBe(0);
        expect(moved(before.get(name)!, own.get(name)!), `${name} as GateLab reads it`).toBe(0);
      }
      // The L: still a polygon, on FlowJo's grid now, each moved coordinate less than a channel away.
      expect(element(xml, "L_shape")).toBe("PolygonGate");
      expect(moved(before.get("L_shape")!, grid.get("L_shape")!)).toBe(0);
      const written = writtenPolygon(xml, "L_shape")!;
      expect(written).toHaveLength(drawn.length);
      let shifted = 0;
      written.forEach((v, i) => {
        for (const k of [0, 1]) {
          expect(Math.abs(v[k] - drawn[i][k])).toBeLessThan(1);
          if (v[k] !== drawn[i][k]) shifted++;
        }
      });
      expect(shifted).toBeGreaterThan(0);
      expect(named(warnings, "L shape")).toBeNull();
      expect(element(xml, "Box")).toBe("RectangleGate");
      expect(moved(before.get("Box")!, grid.get("Box")!)).toBe(0);
      // The split L goes out as drawn, named with the events FlowJo's grid reads otherwise.
      expect(element(xml, "Split")).toBe("PolygonGate");
      expect(writtenPolygon(xml, "Split")).toEqual(split);
      const splitOff = moved(before.get("Split")!, grid.get("Split")!);
      expect(splitOff).toBeGreaterThan(0);
      expect(named(warnings, "Split")).toBe(splitOff);
    });
  });

  const CALIBUR = `${VENDOR_MATRIX_DIR}/curated-from-fcsparser/BD_FACSCalibur_FCS2.0.fcs`;
  const S8 = `${VENDOR_MATRIX_DIR}/bd_facsdiscover_s8__19221995__Zam36_YFP.fcs`;
  for (const [label, path] of [["FACSCalibur", CALIBUR], ["FACSDiscover S8", S8]] as const) {
    it.runIf(existsSync(path))(`writes a strip on a log floor of the public ${label} file where FlowJo's grid holds what GateLab holds`, { timeout: 120000 }, () => {
      const sample = load(path);
      // A fluorescence channel with events at or below 1 (the log's floor) and above it, and forward scatter.
      let fl = "";
      let most = -1;
      for (const [i, c] of sample.channels.entries()) {
        if (/time|fsc|ssc/i.test(c.pnn)) continue;
        const raw = sample.rawColumnData(i);
        let k = 0;
        for (let j = 0; j < raw.length; j++) if (raw[j] <= 1) k++;
        if (k > most && k < raw.length) [most, fl] = [k, c.key];
      }
      const fsc = sample.channels.find((c) => /fsc/i.test(c.pnn))!.key;
      expect(most).toBeGreaterThan(0);
      const q = (p: number) => quantile(sample, fsc, p);
      const onLog = { space: "display" as const, transforms: { [fsc]: { kind: "identity" as const }, [fl]: wsplog } };
      const b = new TreeBuilder();
      const add = (name: string, gate: Gate) => b.pop(name, [{ gate: b.gate(gate) }], b.root);
      add("On_floor", { ...newGate("On floor", "polygon", fsc, fl, [[q(0.2), -0.6], [q(0.6), -0.6], [q(0.6), 0], [q(0.2), 0]]), ...onLog } as Gate);
      add("Comb", {
        ...newGate("Comb", "polygon", fsc, fl, [[q(0.1), -0.6], [q(0.9), -0.6], [q(0.9), 0], [q(0.7), 0], [q(0.7), -0.3], [q(0.3), -0.3], [q(0.3), 0], [q(0.1), 0]]), ...onLog,
      } as Gate);
      add("Raw_range", { ...newGate("Raw range", "rectangle", fsc, fl, [[q(0), -50], [q(1), 0.5]]), space: "raw", bounds: "half-open" } as Gate);
      const tree = b.tree();
      const before = evaluate(sample, tree);
      expect(count(before.get("On_floor")!)).toBeGreaterThan(0);
      const { xml, warnings } = exportFlowJoWorkspace({ samples: [{ sample, fileName: "public.fcs", ...tree }], now: new Date("2026-09-26T00:00:00Z"), producer: "GateLab test" });
      const grid = onGrid(xml, load(path));
      const own = evaluate(load(path), importWorkspace(xml, load(path), 0, { flowJoGrid: true }));
      expect(element(xml, "On_floor")).toBe("RectangleGate");
      expect(moved(before.get("On_floor")!, grid.get("On_floor")!)).toBe(0);
      // No bound on an event: a half-open reader holds the strip as GateLab does (at 5473470 FlowKit
      // left out 89 of the FACSCalibur file's 22,112 events there).
      const strip = halfOpen(xml, "On_floor", load(path));
      for (const b of strip.bounds) expect(onAnEvent(b), `bound ${b.lo}..${b.hi}`).toBe(false);
      expect(moved(before.get("On_floor")!, strip.mask)).toBe(0);
      for (const name of ["On_floor", "Comb", "Raw_range"]) expect(moved(before.get(name)!, own.get(name)!), name).toBe(0);
      const combOff = moved(before.get("Comb")!, grid.get("Comb")!);
      expect(combOff).toBeGreaterThan(0);
      expect(named(warnings, "Comb")).toBe(combOff);
    });
  }
});
