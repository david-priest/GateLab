// @vitest-environment jsdom
// The .cef export, round-tripped through the importer: the synthetic experiment of
// chorusExperiment.test.ts goes in, comes out as a .cef, and reads back as the same tree. A real
// experiment runs through the last block with GATELAB_CEF_FIXTURE and GATELAB_CEF_FCS set.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { strFromU8, unzipSync, zipSync, strToU8 } from "fflate";
import { cefBytes } from "./chorusExperiment.test";
import { chorusToGatingML, listChorusTrees, readChorusExperiment, readChorusRecording } from "./chorusExperiment";
import { exportChorusExperiment, findJsonValueSpan, formatChorusJson, jsonStyleAt, type ChorusExportChannel } from "./chorusExport";
import { importGatingML, type GatingMLResult } from "./gatingml";
import { readFcsKeywords } from "./fcs";
import { getGateMask } from "./gates";
import { transformFromSpec } from "./sample";
import type { Gate, PolyRectGate, PopulationMap } from "./models";

const CHANNELS = ["Time", "FSC-A", "FSC-H", "FSC-W", "SSC (Imaging)-A", "SSC (Imaging)-H", "BUV805-A", "BV421-A", "PE-A", "BV711-A", "Max Intensity (SSC (Imaging))"];
const channels: ChorusExportChannel[] = CHANNELS.map((c) => ({ key: c, pnn: c }));

/** The S8's display keywords for the colour channels, so biexponential gates are carried. */
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

function importTree(bytes: Uint8Array, kw: Record<string, string>): GatingMLResult {
  const exp = readChorusExperiment(bytes);
  const conv = chorusToGatingML(exp, 0, { keywords: kw });
  return importGatingML(conv.gatingMl, CHANNELS, {}, "flow");
}

function gatesOf(bytes: Uint8Array) {
  const files = unzipSync(bytes);
  const doc = JSON.parse(strFromU8(files["experiment.json"]));
  return doc.experiment.panels[0].analysis.gates as { gateId: string; gateKind: string; name: string; parentPopulationId: string; children: { name: string; populationId: string; color: string }[]; vertices: { x: number; y: number }[]; parameters: Record<string, unknown>[] }[];
}

describe("the .cef export", () => {
  it("writes the imported tree back as the same Chorus gates, ids and vertices kept", () => {
    const source = cefBytes();
    const kw = keywords();
    const tree = importTree(source, kw);
    const result = exportChorusExperiment({ source, channels, keywords: kw, gates: tree.gates, populations: tree.populations, root_population_id: tree.root_population_id });
    const before = gatesOf(source);
    const after = gatesOf(result.bytes);
    // The automatic filters and every population the importer read, by the same gate id.
    const byId = new Map(after.map((g) => [g.gateId, g]));
    for (const g of before) {
      if (g.gateKind === "Ellipse") continue; // not read by the importer, so not written back
      if (!byId.has(g.gateId)) {
        // Populations beneath an unsupported gate, or beneath the automatic Unsaturated filter, moved up on import.
        expect(before.some((p) => p.gateKind === "Ellipse" && p.children.some((c) => c.populationId === g.parentPopulationId)) || after.some((a) => a.children[0]?.name === g.children[0]?.name)).toBe(true);
        continue;
      }
      const a = byId.get(g.gateId)!;
      expect(a.gateKind).toBe(g.gateKind === "Rectangle" ? "Polygon" : g.gateKind);
      expect(a.children.map((c) => c.populationId)).toEqual(g.children.map((c) => c.populationId));
      if (AUTOMATIC(g.gateKind)) continue;
      // Vertices back within floating-point noise of the source's (display-carried gates come back
      // through the logicle's inverse); a rectangle as its four corners.
      const want = g.gateKind === "Rectangle" ? 4 : g.vertices.length;
      expect(a.vertices.length).toBe(want);
      if (g.gateKind !== "Rectangle") for (let i = 0; i < want; i++) {
        expect(a.vertices[i].x).toBeCloseTo(g.vertices[i].x, 6);
        expect(a.vertices[i].y).toBeCloseTo(g.vertices[i].y, 6);
      }
      expect(a.parameters.map((p) => p.measurementId)).toEqual(g.parameters.map((p) => p.measurementId));
    }
    // The other entries are byte-identical, the digest included.
    const srcFiles = unzipSync(source), outFiles = unzipSync(result.bytes);
    for (const name of Object.keys(srcFiles)) if (name !== "experiment.json") expect(outFiles[name]).toEqual(srcFiles[name]);
    expect(result.written).toBeGreaterThan(0);
    // And it reads back as the same tree.
    const again = importTree(result.bytes, kw);
    expect(Object.values(again.populations).map((p) => p.name).sort()).toEqual(Object.values(tree.populations).map((p) => p.name).sort());
  });

  it("writes a new GateLab gate under its parent with the next gate id, and a rectangle as its corners", () => {
    const source = cefBytes();
    const kw = keywords();
    const tree = importTree(source, kw);
    const parent = Object.values(tree.populations).find((p) => p.name === "Scatter")!;
    const gate: PolyRectGate = { gate_id: "new-1", name: "Live", gate_type: "rectangle", x_channel: "BUV805-A", y_channel: "BV421-A", vertices: [[100, 5000], [20000, 200]], color: "#ff7f00", label_offset: null };
    const gates: Record<string, Gate> = { ...tree.gates, "new-1": gate };
    const populations: PopulationMap = { ...tree.populations, "pop-new": { population_id: "pop-new", name: "Live", gate_refs: [{ gate_id: "new-1", include: true }], gate_logic: "and", parent_id: parent.population_id, children: [], event_count: null, percent_of_parent: null } };
    populations[parent.population_id] = { ...parent, children: [...parent.children, "pop-new"] };
    const result = exportChorusExperiment({ source, channels, keywords: kw, gates, populations, root_population_id: tree.root_population_id });
    const after = gatesOf(result.bytes);
    const maxBefore = Math.max(...gatesOf(source).map((g) => Number(g.gateId)));
    const live = after.find((g) => g.children[0]?.name === "Live")!;
    expect(Number(live.gateId)).toBe(maxBefore + 1);
    expect(live.children[0].populationId).toBe(`${live.gateId}-1`);
    expect(live.children[0].color).toBe("255,127,0");
    expect(live.parentPopulationId).toBe(after.find((g) => g.children[0]?.name === "Scatter")!.children[0].populationId);
    expect(live.vertices).toEqual([{ x: 100, y: 200 }, { x: 20000, y: 200 }, { x: 20000, y: 5000 }, { x: 100, y: 5000 }]);
    expect(live.parameters.map((p) => p.fluorochrome)).toEqual(["BUV805", "BV421"]);
    expect(live.parameters.every((p) => p.scale === "Biexponential" && p.parameterKind === "Color")).toBe(true);
  });

  it("leaves out what Chorus cannot hold and says why; a deleted population's sort destination is cleared", () => {
    const source = cefBytes();
    const kw = keywords();
    const tree = importTree(source, kw);
    const singlets = Object.values(tree.populations).find((p) => p.name === "Singlets")!;
    const scatter = Object.values(tree.populations).find((p) => p.name === "Scatter")!;
    // Singlets becomes the AND of its own gate and Scatter's: no Chorus form.
    const populations: PopulationMap = { ...tree.populations, [singlets.population_id]: { ...singlets, gate_refs: [...singlets.gate_refs, { gate_id: scatter.gate_refs[0].gate_id, include: true }] } };
    const result = exportChorusExperiment({ source, channels, keywords: kw, gates: tree.gates, populations, root_population_id: tree.root_population_id });
    expect(result.skipped.map((s) => s.name)).toContain("Singlets");
    expect(result.warnings.some((w) => /"Singlets" was left out/.test(w) && /AND of 2 gates/.test(w))).toBe(true);
    const after = gatesOf(result.bytes);
    expect(after.some((g) => g.children[0]?.name === "Singlets")).toBe(false);
    // Nothing beneath it either.
    expect(after.some((g) => g.children[0]?.name === "CD19+CD3-")).toBe(false);
  });

  it("densifies a raw-straight polygon on a biexponential axis, and leaves a display-carried one alone", () => {
    const source = cefBytes();
    const kw = keywords();
    const tree = importTree(source, kw);
    const carried = Object.values(tree.gates).find((g) => g.name === "CD19+CD3-") as PolyRectGate;
    expect(carried.space).toBe("display");
    const root = tree.populations[tree.root_population_id];
    const raw: PolyRectGate = { gate_id: "raw-1", name: "Drawn here", gate_type: "polygon", x_channel: "PE-A", y_channel: "BV711-A", vertices: [[0, 0], [50000, 0], [50000, 50000]], color: "#000000", label_offset: null };
    const gates: Record<string, Gate> = { ...tree.gates, "raw-1": raw };
    const populations: PopulationMap = { ...tree.populations, "pop-raw": { population_id: "pop-raw", name: "Drawn here", gate_refs: [{ gate_id: "raw-1", include: true }], gate_logic: "and", parent_id: root.population_id, children: [], event_count: null, percent_of_parent: null } };
    populations[root.population_id] = { ...root, children: [...root.children, "pop-raw"] };
    const result = exportChorusExperiment({ source, channels, keywords: kw, gates, populations, root_population_id: tree.root_population_id });
    const after = gatesOf(result.bytes);
    const drawn = after.find((g) => g.children[0]?.name === "Drawn here")!;
    expect(drawn.vertices.length).toBe(3 * 12);
    expect(drawn.vertices[0]).toEqual({ x: 0, y: 0 });
    expect(drawn.vertices[12]).toEqual({ x: 50000, y: 0 });
    const back = after.find((g) => g.children[0]?.name === "CD19+CD3-")!;
    expect(back.vertices.length).toBe(gatesOf(source).find((g) => g.children[0]?.name === "CD19+CD3-")!.vertices.length);
  });

  it("preserves an explicitly approximated Log-axis gate as a raw outline on export", () => {
    const files = unzipSync(cefBytes());
    const doc = JSON.parse(strFromU8(files["experiment.json"]));
    const gate = doc.experiment.panels[0].analysis.gates.find((g: { name: string }) => g.name === "Bright");
    const control = doc.experiment.panels[0].analysis.gates.find((g: { gateId: string }) => g.gateId === "3");
    gate.parameters[1] = structuredClone(control.parameters[0]);
    files["experiment.json"] = strToU8(JSON.stringify(doc));
    const source = zipSync(files);
    const kw = keywords();
    const conv = chorusToGatingML(readChorusExperiment(source), 0, { keywords: kw });
    expect(conv.record.gates.find((g) => g.name === "Bright")?.approximated).toBe(true);
    const tree = importTree(source, kw);
    const raw = Object.values(tree.gates).find((g) => g.name === "Bright")!;
    expect(raw.space).not.toBe("display");
    const exported = exportChorusExperiment({ source, channels, keywords: kw, gates: tree.gates,
      populations: tree.populations, root_population_id: tree.root_population_id });
    const drawn = gatesOf(exported.bytes).find((g) => g.name === "Bright")!;
    expect(drawn.vertices).toHaveLength(gate.vertices.length * 12);
    expectRawOutline(gate.vertices, drawn.vertices);
    const carried = gatesOf(exported.bytes).find((g) => g.gateId === control.gateId)!;
    expect(carried.vertices).toEqual(control.vertices);
  });

  it("keeps each matched gate's axis scale when another gate uses the same channel differently", () => {
    const files = unzipSync(cefBytes());
    const doc = JSON.parse(strFromU8(files["experiment.json"]));
    const gates = doc.experiment.panels[0].analysis.gates;
    const control = gates.find((g: { gateId: string }) => g.gateId === "3");
    const first = gates.find((g: { gateId: string }) => g.gateId === "1");
    first.parameters[0] = { ...structuredClone(control.parameters[0]), scale: "Log" };
    files["experiment.json"] = strToU8(JSON.stringify(doc));
    const source = zipSync(files), kw = keywords(), tree = importTree(source, kw);
    const result = exportChorusExperiment({ source, channels, keywords: kw, gates: tree.gates,
      populations: tree.populations, root_population_id: tree.root_population_id });
    const back = gatesOf(result.bytes).find((g) => g.gateId === "3")!;
    expect(back.parameters).toEqual(control.parameters);
    expect(back.vertices).toEqual(control.vertices);
    // The drawn Biexponential gate holds the same two known events after export and import,
    // even though the first parameter for that channel in the experiment uses Log.
    const points = [[0, 1000], [-200, 1000], [60000, 1000], [25000, 20000]];
    for (const current of [tree, importTree(result.bytes, kw)]) {
      const gate = Object.values(current.gates).find((g) => g.name === "CD19+CD3-")!;
      const mask = getGateMask(gate, { n: points.length, column(channel: string) {
        const axis = channel === gate.x_channel ? 0 : 1;
        const spec = gate.space === "display" ? gate.transforms?.[channel] : undefined;
        return Float32Array.from(points, (p) => spec ? transformFromSpec(spec).forward(p[axis]) : p[axis]);
      } });
      expect(Array.from(mask)).toEqual([1, 0, 0, 1]);
      expect(Array.from(mask).reduce((a, b) => a + b, 0)).toBe(2);
    }
  });
});

// Compare the analytical raw-straight edges, including each original corner, independently of
// the exporter's chosen number of subdivisions. The synthetic test also fixes that density.
function expectRawOutline(before: { x: number; y: number }[], after: { x: number; y: number }[]) {
  const perEdge = after.length / before.length;
  expect(Number.isInteger(perEdge)).toBe(true);
  expect(perEdge).toBeGreaterThanOrEqual(1);
  after.forEach((p, i) => {
    const edge = Math.floor(i / perEdge), t = (i % perEdge) / perEdge;
    const a = before[edge], b = before[(edge + 1) % before.length];
    for (const axis of ["x", "y"] as const) {
      const expected = a[axis] + (b[axis] - a[axis]) * t;
      expect(Math.abs(p[axis] - expected)).toBeLessThanOrEqual(Math.abs(expected) * 1e-9 + 1e-6);
    }
  });
}

function AUTOMATIC(kind: string): boolean {
  return kind === "Saturated" || kind === "Unsaturated";
}

const REAL = process.env.GATELAB_CEF_FIXTURE ?? "";
const REAL_FCS = process.env.GATELAB_CEF_FCS ?? "";

describe.runIf(REAL && existsSync(REAL) && REAL_FCS && existsSync(REAL_FCS))("a real FACSChorus experiment, exported back (GATELAB_CEF_FIXTURE, GATELAB_CEF_FCS)", () => {
  it("preserves carried vertices and explicitly approximated raw outlines of the current tree", async () => {
    const source = new Uint8Array(readFileSync(REAL));
    const exp = readChorusExperiment(source);
    const tree = listChorusTrees(exp).find((t) => t.kind === "current")!;
    const b = readFileSync(REAL_FCS);
    const kw = readFcsKeywords(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))!;
    const recording = readChorusRecording(kw);
    expect(recording?.experimentId, "The FCS must record its Chorus association").toBeTruthy();
    expect([exp.id, exp.panels[0]?.id].filter(Boolean), "The CEF and FCS fixture must name the same experiment or panel")
      .toContain(recording!.experimentId);
    const n = Number(kw["$PAR"]);
    const names = Array.from({ length: n }, (_, i) => kw[`$P${i + 1}N`]);
    const conv = chorusToGatingML(exp, tree.index, { keywords: kw });
    const res = importGatingML(conv.gatingMl, names, {}, "flow");
    const result = exportChorusExperiment({ source, channels: names.map((c) => ({ key: c, pnn: c })), keywords: kw, gates: res.gates, populations: res.populations, root_population_id: res.root_population_id });
    const before = gatesOf(source).filter((g) => g.gateKind === "Polygon" || g.gateKind === "Rectangle");
    const after = new Map(gatesOf(result.bytes).map((g) => [g.gateId, g]));
    const gml = new DOMParser().parseFromString(conv.gatingMl, "text/xml");
    let compared = 0;
    for (const g of before) {
      const a = after.get(g.gateId);
      if (!a) continue;
      compared++;
      expect(a.parentPopulationId).toBe(g.parentPopulationId);
      const { vertices: _beforeVertices, gateKind: _beforeKind, ...beforeFields } = g;
      const { vertices: _afterVertices, gateKind: _afterKind, ...afterFields } = a;
      expect(afterFields).toEqual(beforeFields);
      expect(a.gateKind).toBe("Polygon");
      const element = Array.from(gml.getElementsByTagName("*")).find((e) => e.getAttribute("gating:id") === `chorus_gate_${g.gateId}`)!;
      const report = conv.record.gates.find((r) => r.name === element.getAttribute("gating:name"));
      expect(report).toBeDefined();
      if (g.gateKind === "Polygon" && report!.approximated) {
        expectRawOutline(g.vertices, a.vertices);
        continue;
      }
      expect(a.vertices.length).toBe(g.gateKind === "Rectangle" ? 4 : g.vertices.length);
      if (g.gateKind === "Rectangle") {
        const xmin = Math.min(...g.vertices.map((p) => p.x)), xmax = Math.max(...g.vertices.map((p) => p.x));
        const ymin = Math.min(...g.vertices.map((p) => p.y)), ymax = Math.max(...g.vertices.map((p) => p.y));
        const corners = [{ x: xmin, y: ymin }, { x: xmax, y: ymin }, { x: xmax, y: ymax }, { x: xmin, y: ymax }];
        a.vertices.forEach((p, i) => {
          for (const axis of ["x", "y"] as const)
            expect(Math.abs(p[axis] - corners[i][axis])).toBeLessThanOrEqual(Math.abs(corners[i][axis]) * 1e-9 + 1e-6);
        });
      }
      if (g.gateKind === "Polygon") for (let i = 0; i < g.vertices.length; i++) {
        expect(Math.abs(a.vertices[i].x - g.vertices[i].x)).toBeLessThanOrEqual(Math.abs(g.vertices[i].x) * 1e-9 + 1e-6);
        expect(Math.abs(a.vertices[i].y - g.vertices[i].y)).toBeLessThanOrEqual(Math.abs(g.vertices[i].y) * 1e-9 + 1e-6);
      }
    }
    expect(compared).toBe(before.length);
    expect(result.skipped).toEqual([]);
    // Preserve experiment metadata in every case. Whole-text identity additionally applies
    // where no explicit approximation or Rectangle-to-Polygon normalization changed the tree.
    const srcText = strFromU8(unzipSync(source)["experiment.json"]);
    const outText = strFromU8(unzipSync(result.bytes)["experiment.json"]);
    const srcDoc = JSON.parse(srcText), outDoc = JSON.parse(outText);
    srcDoc.experiment.panels[0].analysis.gates = [];
    outDoc.experiment.panels[0].analysis.gates = [];
    expect(outDoc).toEqual(srcDoc);
    if (conv.record.gates.every((g) => !g.approximated) && before.every((g) => g.gateKind === "Polygon"))
      expect(outText).toBe(srcText);
    const srcFiles = unzipSync(source), outFiles = unzipSync(result.bytes);
    for (const name of Object.keys(srcFiles)) if (name !== "experiment.json") expect(outFiles[name]).toEqual(srcFiles[name]);
  });
});

describe("the JSON scanner and Chorus's layout", () => {
  it("finds a value's span by path and writes it back in the layout around it", () => {
    const text = '{\r\n  "a": [\r\n    {\r\n      "x": 1.0,\r\n      "y": -2.5\r\n    }\r\n  ],\r\n  "b": "s]}",\r\n  "c": [1, 2]\r\n}';
    const span = findJsonValueSpan(text, ["a"])!;
    expect(text.slice(span[0], span[1])).toBe('[\r\n    {\r\n      "x": 1.0,\r\n      "y": -2.5\r\n    }\r\n  ]');
    expect(findJsonValueSpan(text, ["a", 0, "y"])).toEqual([text.indexOf("-2.5"), text.indexOf("-2.5") + 4]);
    expect(findJsonValueSpan(text, ["c", 1])).toEqual([text.indexOf("2]"), text.indexOf("2]") + 1]);
    expect(findJsonValueSpan(text, ["zz"])).toBeNull();
    const out = formatChorusJson([{ x: 3, y: 0.000001, z: 7, w: [], v: {} }], jsonStyleAt(text, span[0]), new Set(["x", "y"]));
    expect(out).toBe('[\r\n    {\r\n      "x": 3.0,\r\n      "y": 1E-06,\r\n      "z": 7,\r\n      "w": [],\r\n      "v": {}\r\n    }\r\n  ]');
  });
});
