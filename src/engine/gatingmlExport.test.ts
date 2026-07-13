// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseFcs } from "./fcs";
import { Sample } from "./sample";
import { exportGatingML } from "./gatingmlExport";
import { importGatingML } from "./gatingml";
import {
  newRootPopulation,
  newPopulation,
  newGateRef,
  linkChildToParent,
  type Gate,
  type PopulationMap,
  type Vertex,
} from "./models";

const ARIA_SMALL =
  "/Users/davidpriest/code/gatelabr-test-fcs/conventional_comp_AriaIII/sample_Bmem_purity_small.fcs";

function loadArrayBuffer(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

const uuid = () => crypto.randomUUID();

/** Build a small workspace: a scatter rectangle and a fluorophore polygon, with a
 *  parent→child population tree (child excludes the polygon). Returns raw-space gates. */
function buildWorkspace(sample: Sample) {
  // scatter x scatter (FSC-A x SSC-A → fasinh) and fluor x fluor (→ logicle)
  const scatterIdx = sample.channels.findIndex((_, i) => sample.transformKind(i) === "asinh");
  const scatter2 = sample.channels.findIndex(
    (_, i) => sample.transformKind(i) === "asinh" && i !== scatterIdx,
  );
  const logicleIdxs = sample.channels
    .map((_, i) => i)
    .filter((i) => sample.transformKind(i) === "logicle");
  const [fx, fy] = [logicleIdxs[0], logicleIdxs[1]];

  const sKeyX = sample.channels[scatterIdx].key;
  const sKeyY = sample.channels[scatter2].key;
  const fKeyX = sample.channels[fx].key;
  const fKeyY = sample.channels[fy].key;

  // Rectangle in RAW scatter space.
  const rectVerts: Vertex[] = [
    [20000, 10000],
    [80000, 10000],
    [80000, 90000],
    [20000, 90000],
  ];
  // Polygon in RAW fluorophore space (spans negative → positive, like real logicle data).
  const polyVerts: Vertex[] = [
    [-200, -100],
    [3000, -100],
    [4000, 5000],
    [500, 8000],
    [-200, 2000],
  ];

  const rect: Gate = {
    gate_id: uuid(),
    name: "Cells",
    gate_type: "rectangle",
    x_channel: sKeyX,
    y_channel: sKeyY,
    vertices: rectVerts,
    color: "#e41a1c",
    label_offset: null,
  };
  const poly: Gate = {
    gate_id: uuid(),
    name: "PE+APC gate",
    gate_type: "polygon",
    x_channel: fKeyX,
    y_channel: fKeyY,
    vertices: polyVerts,
    color: "#377eb8",
    label_offset: null,
  };
  const gates: Record<string, Gate> = { [rect.gate_id]: rect, [poly.gate_id]: poly };
  const gate_order = [rect.gate_id, poly.gate_id];

  const root = newRootPopulation();
  let pops: PopulationMap = { [root.population_id]: root };
  const pCells = newPopulation("Cells", [newGateRef(rect.gate_id, true)], root.population_id);
  pops[pCells.population_id] = pCells;
  pops = linkChildToParent(pops, pCells.population_id, root.population_id);
  // child EXCLUDES the polygon → tests complement round-trip
  const pNeg = newPopulation("PE-APC- of Cells", [newGateRef(poly.gate_id, false)], pCells.population_id);
  pops[pNeg.population_id] = pNeg;
  pops = linkChildToParent(pops, pNeg.population_id, pCells.population_id);

  return { gates, gate_order, populations: pops, root_population_id: root.population_id };
}

describe("GatingML export → import round-trip (Aria III flow)", () => {
  const sample = new Sample(parseFcs(loadArrayBuffer(ARIA_SMALL)));
  const ws = buildWorkspace(sample);
  const sessionChannels = sample.channels.map((c) => c.key);
  const pnnMap: Record<string, string> = {};
  for (const c of sample.channels) pnnMap[c.pnn] = c.key;

  for (const format of ["standard", "cytobank"] as const) {
    describe(`${format} format`, () => {
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "2026-01-01T00:00:00" });
      const back = importGatingML(xml, sessionChannels, pnnMap);

      it("is valid XML with the right header + gate elements", () => {
        expect(xml).toContain("<gating:Gating-ML");
        expect(xml).toContain("<gating:RectangleGate");
        expect(xml).toContain("<gating:PolygonGate");
        expect(xml).toContain(format === "cytobank" ? "Cytobank-compatible" : "re-importable");
        if (format === "standard") expect(xml).toContain("<gating:GatingHierarchy");
      });

      it("re-imports both gates with the same channels", () => {
        expect(back.n_gates_imported).toBe(2);
        const byName = Object.fromEntries(Object.values(back.gates).map((g) => [g.name, g]));
        expect(byName["Cells"].x_channel).toBe(ws.gates[ws.gate_order[0]].x_channel);
        expect(byName["PE+APC gate"].x_channel).toBe(ws.gates[ws.gate_order[1]].x_channel);
      });

      it("recovers the raw vertices through the transform round-trip", () => {
        const byName = Object.fromEntries(Object.values(back.gates).map((g) => [g.name, g]));
        // rectangle: AABB corners recovered (order-independent → compare min/max)
        const origRect = ws.gates[ws.gate_order[0]];
        const rx = byName["Cells"].gate_type !== "quadrant" ? (byName["Cells"] as { vertices: Vertex[] }).vertices : [];
        const oxs = origRect.gate_type !== "quadrant" ? origRect.vertices.map((v) => v[0]) : [];
        const rxs = rx.map((v) => v[0]);
        expect(Math.min(...rxs)).toBeCloseTo(Math.min(...oxs), 0);
        expect(Math.max(...rxs)).toBeCloseTo(Math.max(...oxs), 0);

        // polygon (logicle): every vertex recovered to within 1% (relative)
        const origPoly = ws.gates[ws.gate_order[1]];
        const rp = (byName["PE+APC gate"] as { vertices: Vertex[] }).vertices;
        const op = origPoly.gate_type !== "quadrant" ? origPoly.vertices : [];
        expect(rp.length).toBe(op.length);
        for (let i = 0; i < op.length; i++) {
          for (let k = 0; k < 2; k++) {
            const denom = Math.max(Math.abs(op[i][k]), 1);
            expect(Math.abs(rp[i][k] - op[i][k]) / denom).toBeLessThan(0.01);
          }
        }
      });

      it("recovers the population tree with include/exclude", () => {
        expect(back.n_pops_imported).toBe(2);
        const pops = Object.values(back.populations).filter((p) => p.parent_id !== null);
        const cells = pops.find((p) => p.name === "Cells");
        const neg = pops.find((p) => p.name.startsWith("PE-APC-"));
        expect(cells).toBeDefined();
        expect(neg).toBeDefined();
        // child's parent is the Cells population
        expect(neg!.parent_id).toBe(cells!.population_id);
        // the polygon ref is an EXCLUDE
        expect(neg!.gate_refs[0].include).toBe(false);
      });

      it("persists logicle W in gatelabr_scales", () => {
        expect(xml).toContain("<gatelabr_scales>");
        expect(back.scales).not.toBeNull();
      });

      it("round-trips the display range (lo/hi) via gatelabr_scales", () => {
        const chKey = sample.channels[0].key;
        const xml2 = exportGatingML({
          ...ws, sample, format, timestamp: "2026-01-01T00:00:00",
          globalScales: { [chKey]: [-12.5, 987.5] },
        });
        const back2 = importGatingML(xml2, sessionChannels, pnnMap);
        expect(back2.scales?.[chKey]?.lo).toBeCloseTo(-12.5, 3);
        expect(back2.scales?.[chKey]?.hi).toBeCloseTo(987.5, 3);
      });
    });
  }
});

describe("GatingML Boolean OR fidelity", () => {
  const sample = new Sample(parseFcs(loadArrayBuffer(ARIA_SMALL)));
  const sessionChannels = sample.channels.map((c) => c.key);
  const pnnMap = Object.fromEntries(sample.channels.map((c) => [c.pnn, c.key]));

  function rootOrWorkspace() {
    const ws = buildWorkspace(sample);
    const root = ws.populations[ws.root_population_id];
    const orPop = newPopulation(
      "Scatter OR signal",
      ws.gate_order.map((gid) => newGateRef(gid, true)),
      ws.root_population_id,
      "or",
    );
    ws.populations[orPop.population_id] = orPop;
    linkChildToParent(ws.populations, orPop.population_id, root.population_id);
    return { ws, orPop };
  }

  for (const format of ["standard", "cytobank"] as const) {
    it(`round-trips a root-level OR population in ${format} format`, () => {
      const { ws } = rootOrWorkspace();
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "2026-01-01T00:00:00" });
      expect(xml).toContain("<gating:or>");
      const back = importGatingML(xml, sessionChannels, pnnMap);
      const pop = Object.values(back.populations).find((p) => p.name === "Scatter OR signal");
      expect(pop).toBeDefined();
      expect(pop!.gate_logic).toBe("or");
      expect(pop!.gate_refs).toHaveLength(2);
    });
  }

  it("preserves a nested OR population in standard format", () => {
    const ws = buildWorkspace(sample);
    const parent = Object.values(ws.populations).find((p) => p.name === "Cells")!;
    const nested = newPopulation(
      "Nested OR",
      ws.gate_order.map((gid) => newGateRef(gid, true)),
      parent.population_id,
      "or",
    );
    ws.populations[nested.population_id] = nested;
    linkChildToParent(ws.populations, nested.population_id, parent.population_id);
    const xml = exportGatingML({ ...ws, sample, format: "standard" });
    const back = importGatingML(xml, sessionChannels, pnnMap);
    const pop = Object.values(back.populations).find((p) => p.name === "Nested OR");
    expect(pop?.gate_logic).toBe("or");
    expect(pop?.parent_id).not.toBe(back.root_population_id);
  });

  it("blocks Cytobank-compatible export rather than corrupting a nested OR population", () => {
    const ws = buildWorkspace(sample);
    const parent = Object.values(ws.populations).find((p) => p.name === "Cells")!;
    const nested = newPopulation(
      "Nested OR",
      ws.gate_order.map((gid) => newGateRef(gid, true)),
      parent.population_id,
      "or",
    );
    ws.populations[nested.population_id] = nested;
    linkChildToParent(ws.populations, nested.population_id, parent.population_id);
    expect(() => exportGatingML({ ...ws, sample, format: "cytobank" })).toThrow(
      /cannot safely represent the nested OR population "Nested OR"/,
    );
  });
});
