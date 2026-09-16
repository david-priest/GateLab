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
import { flowJoWorkspaceToGatingML, listFlowJoWorkspaceSamples } from "./flowjoWorkspace";
import { importGatingML, resolveGatingMLCompensation } from "./gatingml";
import { applyGatingStrategy } from "./populations";
import {
  linkChildToParent, newGate, newGateRef, newPopulation, newQuadrantGate, newRootPopulation,
  flowJoCurlForDisplay, type Gate, type PopulationMap, type Vertex,
} from "./models";
import { ARIA_SMALL, FIXTURES_ROOT, Z2DR_WORKSPACE } from "../testFixtures";

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
function roundTrip(entry: FlowJoExportSample, fresh: Sample): { masks: Map<string, Uint8Array>; xml: string; warnings: string[]; conv: ReturnType<typeof flowJoWorkspaceToGatingML> } {
  const { xml, warnings } = exportFlowJoWorkspace({ samples: [entry], now: new Date("2026-09-14T00:00:00Z"), producer: "GateLab test" });
  const summaries = listFlowJoWorkspaceSamples(xml);
  expect(summaries).toHaveLength(1);
  expect(summaries[0].candidateFileNames).toContain(entry.fileName);
  const conv = flowJoWorkspaceToGatingML(xml, 0, null);
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
    const conv = flowJoWorkspaceToGatingML(text, found.s.index, null);
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
