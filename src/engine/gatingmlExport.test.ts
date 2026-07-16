// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseFcs, type FcsFile } from "./fcs";
import { Sample } from "./sample";
import { analyzeGatingMLQuadrantOmissions, exportGatingML } from "./gatingmlExport";
import { importGatingML, resolveGatingMLCompensation, restoreGatingMLScaleState } from "./gatingml";
import { getGateMask } from "./gates";
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
 *  positive-AND parent→child population tree. Returns raw-space gates. */
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
  const pSignal = newPopulation("PE+APC+ of Cells", [newGateRef(poly.gate_id, true)], pCells.population_id);
  pops[pSignal.population_id] = pSignal;
  pops = linkChildToParent(pops, pSignal.population_id, pCells.population_id);

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

      it("recovers the positive-AND population tree", () => {
        expect(back.n_pops_imported).toBe(2);
        const pops = Object.values(back.populations).filter((p) => p.parent_id !== null);
        const cells = pops.find((p) => p.name === "Cells");
        const signal = pops.find((p) => p.name.startsWith("PE+APC+"));
        expect(cells).toBeDefined();
        expect(signal).toBeDefined();
        // child's parent is the Cells population
        expect(signal!.parent_id).toBe(cells!.population_id);
        expect(signal!.gate_refs[0].include).toBe(true);
      });

      it("persists logicle W in gatelabr_scales", () => {
        expect(xml).toContain("<gatelabr_scales>");
        expect(back.scales).not.toBeNull();
      });

      it("round-trips transform-neutral axis endpoints and a non-default scatter cofactor", () => {
        const scatterIdx = sample.index("FSC-A")!;
        sample.setScatterCofactor(scatterIdx, 300);
        const chKey = sample.channels[scatterIdx].key;
        const displayRange: [number, number] = [-1, 8];
        const xml2 = exportGatingML({
          ...ws, sample, format, timestamp: "2026-01-01T00:00:00",
          globalScales: { [chKey]: displayRange },
        });
        const back2 = importGatingML(xml2, sessionChannels, pnnMap);
        expect(xml2).toContain('"version":3');
        expect(back2.scales?.[chKey]?.lo).toBeCloseTo(displayRange[0], 6); // legacy reader field
        expect(back2.scales?.[chKey]?.hi).toBeCloseTo(displayRange[1], 6);
        expect(back2.scales?.[chKey]?.raw_lo).toBeCloseTo(300 * Math.sinh(displayRange[0]), 6);
        expect(back2.scales?.[chKey]?.raw_hi).toBeCloseTo(300 * Math.sinh(displayRange[1]), 3);

        const destination = new Sample(parseFcs(loadArrayBuffer(ARIA_SMALL)));
        const restored = restoreGatingMLScaleState(destination, back2.scales, back2.cytof_cofactor);
        expect(destination.currentScatterCofactor(destination.index(chKey)!)).toBe(300);
        expect(restored.ranges[chKey][0]).toBeCloseTo(displayRange[0], 6);
        expect(restored.ranges[chKey][1]).toBeCloseTo(displayRange[1], 6);
      });
    });
  }
});

describe("GatingML CyTOF cofactor/display fidelity", () => {
  const mk = (values: number[]) => Float32Array.from(values);
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents: 6,
    instrument: "cytof",
    keywords: {},
    spillover: null,
    channels: [
      { index: 0, name: "Time", marker: null, bits: 32, range: 1 },
      { index: 1, name: "Ce140Di", marker: "CD3", bits: 32, range: 1 },
      { index: 2, name: "Nd144Di", marker: "CD19", bits: 32, range: 1 },
    ],
    columns: [
      mk([1, 2, 3, 4, 5, 6]),
      mk([0, 10, 100, 1000, 5000, 10000]),
      mk([0, 20, 200, 2000, 7000, 12000]),
    ],
  };

  it("restores the producer's cofactor before evaluating imported display-space gates", () => {
    const source = new Sample(fcs, { cytofCofactor: 10 });
    const root = newRootPopulation();
    const gate: Gate = {
      gate_id: uuid(), name: "Double positive", gate_type: "rectangle",
      x_channel: "CD3", y_channel: "CD19",
      vertices: [[1, 1], [7, 1], [7, 7], [1, 7]],
      color: "#377eb8", label_offset: null,
    };
    const pop = newPopulation("Double positive", [newGateRef(gate.gate_id)], root.population_id);
    let populations: PopulationMap = { [root.population_id]: root, [pop.population_id]: pop };
    populations = linkChildToParent(populations, pop.population_id, root.population_id);
    const displayRange: [number, number] = [-0.5, 6];
    const xml = exportGatingML({
      gates: { [gate.gate_id]: gate }, gate_order: [gate.gate_id], populations,
      root_population_id: root.population_id, sample: source, format: "standard",
      globalScales: { CD3: displayRange },
    });
    const imported = importGatingML(xml, source.channelNames());
    const destination = new Sample(fcs); // deliberately starts at the default cofactor 5
    const restored = restoreGatingMLScaleState(destination, imported.scales, imported.cytof_cofactor);

    expect(imported.cytof_cofactor).toBe(10);
    expect(destination.arcsinhCofactor).toBe(10);
    expect(restored.ranges.CD3[0]).toBeCloseTo(displayRange[0], 6);
    expect(restored.ranges.CD3[1]).toBeCloseTo(displayRange[1], 6);
    const importedGate = Object.values(imported.gates)[0];
    expect(Array.from(getGateMask(importedGate, destination.gatingData())))
      .toEqual(Array.from(getGateMask(gate, source.gatingData())));
  });
});

describe("GatingML compensation-state fidelity", () => {
  function fixture() {
    const sample = new Sample(parseFcs(loadArrayBuffer(ARIA_SMALL)));
    const ws = buildWorkspace(sample);
    const sessionChannels = sample.channels.map((c) => c.key);
    const pnnMap = Object.fromEntries(sample.channels.map((c) => [c.pnn, c.key]));
    return { sample, ws, sessionChannels, pnnMap };
  }

  it("exports uncompensated dimensions and restores compensation off", () => {
    const { sample, ws, sessionChannels, pnnMap } = fixture();
    const xml = exportGatingML({ ...ws, sample, format: "standard" });
    const back = importGatingML(xml, sessionChannels, pnnMap);

    expect(xml).toContain('gating:compensation-ref="uncompensated"');
    expect(xml).not.toContain('gating:compensation-ref="FCS"');
    expect(back.compensation).toEqual({
      enabled: false,
      reference: "uncompensated",
      channels: [],
    });
    expect(back.compensation_refs).toEqual(["uncompensated"]);
    expect(resolveGatingMLCompensation(
      back.compensation, back.compensation_refs, true, sample.spillover,
    )).toEqual({ target: false, source: "embedded", requiresConfirmation: false });
  });

  it("round-trips and verifies the exact embedded spillover matrix", () => {
    const { sample, ws, sessionChannels, pnnMap } = fixture();
    expect(sample.hasCompensation).toBe(true);
    sample.setCompensation(true);
    expect(sample.compensationEnabled).toBe(true);

    const xml = exportGatingML({ ...ws, sample, format: "standard" });
    const back = importGatingML(xml, sessionChannels, pnnMap);
    expect(xml).toContain('gating:compensation-ref="FCS"');
    expect(xml).toContain('gating:compensation-ref="uncompensated"');
    expect(back.compensation?.enabled).toBe(true);
    expect(back.compensation?.channels).toEqual(sample.spillover?.channels);
    expect(back.compensation?.matrix).toEqual(sample.spillover?.matrix);
    expect(resolveGatingMLCompensation(
      back.compensation, back.compensation_refs, true, sample.spillover,
    )).toEqual({ target: true, source: "embedded", requiresConfirmation: false });
  });

  it("blocks a GateLab file whose recorded spillover matrix differs", () => {
    const { sample, ws, sessionChannels, pnnMap } = fixture();
    sample.setCompensation(true);
    const back = importGatingML(
      exportGatingML({ ...ws, sample, format: "standard" }), sessionChannels, pnnMap,
    );
    const mismatched = {
      ...sample.spillover!,
      matrix: sample.spillover!.matrix.map((row) => [...row]),
    };
    mismatched.matrix[0][1] += 0.01;
    expect(() => resolveGatingMLCompensation(
      back.compensation, back.compensation_refs, true, mismatched,
    )).toThrow(/different FCS spillover matrix/);
  });

  it("requires confirmation for third-party FCS compensation references", () => {
    const { sample, ws, sessionChannels, pnnMap } = fixture();
    sample.setCompensation(true);
    const xml = exportGatingML({ ...ws, sample, format: "standard" }).replace(
      /\s*<gatelabr_scales>[\s\S]*?<\/gatelabr_scales>/,
      "",
    );
    const back = importGatingML(xml, sessionChannels, pnnMap);
    expect(back.compensation).toBeNull();
    expect(resolveGatingMLCompensation(
      back.compensation, back.compensation_refs, true, sample.spillover,
    )).toEqual({ target: true, source: "dimensions", requiresConfirmation: true });
  });

  it("rejects named compensation matrices that GateLab cannot evaluate", () => {
    const { sample, ws, sessionChannels, pnnMap } = fixture();
    sample.setCompensation(true);
    const xml = exportGatingML({ ...ws, sample, format: "standard" }).replace(
      'gating:compensation-ref="FCS"',
      'gating:compensation-ref="vendor-matrix"',
    );
    expect(() => importGatingML(xml, sessionChannels, pnnMap)).toThrow(/unsupported compensation matrix/);
  });

  it("rejects contradictory embedded and per-dimension compensation state", () => {
    const { sample, ws, sessionChannels, pnnMap } = fixture();
    const xml = exportGatingML({ ...ws, sample, format: "standard" }).replace(
      'gating:compensation-ref="uncompensated"',
      'gating:compensation-ref="FCS"',
    );
    const back = importGatingML(xml, sessionChannels, pnnMap);
    expect(() => resolveGatingMLCompensation(
      back.compensation, back.compensation_refs, true, sample.spillover,
    )).toThrow(/contradicts/);
  });
});

describe("GatingML positive-AND import policy", () => {
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
    it(`rejects a root-level OR population exported in ${format} format`, () => {
      const { ws } = rootOrWorkspace();
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "2026-01-01T00:00:00" });
      expect(xml).toContain("<gating:or>");
      expect(() => importGatingML(xml, sessionChannels, pnnMap)).toThrow(
        /Population "Scatter OR signal" uses OR logic/,
      );
    });
  }

  it("rejects a nested OR population in standard format", () => {
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
    expect(() => importGatingML(xml, sessionChannels, pnnMap)).toThrow(
      /Population "Nested OR" uses OR logic/,
    );
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

  it("requires explicit quadrant omission and prunes the entire dependent branch", () => {
    const ws = buildWorkspace(sample);
    const quadrant: Gate = {
      gate_id: "quadrant-1", name: "CD4 CD8 quadrants", gate_type: "quadrant",
      x_channel: ws.gates[ws.gate_order[0]].x_channel,
      y_channel: ws.gates[ws.gate_order[0]].y_channel,
      center: [40000, 40000], color: "#984ea3", label_offset: null,
    };
    ws.gates[quadrant.gate_id] = quadrant;
    ws.gate_order.push(quadrant.gate_id);
    const quadrantPop = newPopulation(
      "Quadrant population", [newGateRef(quadrant.gate_id, true, 2)], ws.root_population_id,
    );
    ws.populations[quadrantPop.population_id] = quadrantPop;
    linkChildToParent(ws.populations, quadrantPop.population_id, ws.root_population_id);
    const descendant = newPopulation(
      "Quadrant descendant", [newGateRef(ws.gate_order[1])], quadrantPop.population_id,
    );
    ws.populations[descendant.population_id] = descendant;
    linkChildToParent(ws.populations, descendant.population_id, quadrantPop.population_id);

    const omissions = analyzeGatingMLQuadrantOmissions(ws.gates, ws.populations);
    expect(new Set(omissions.populationIds)).toEqual(
      new Set([quadrantPop.population_id, descendant.population_id]),
    );
    expect(() => exportGatingML({ ...ws, sample, format: "standard" })).toThrow(
      /explicitly accepting their omission/i,
    );
    const xml = exportGatingML({
      ...ws, sample, format: "standard", allowQuadrantOmission: true,
    });
    expect(xml).not.toContain("Quadrant population");
    expect(xml).not.toContain("Quadrant descendant");
    const back = importGatingML(xml, sessionChannels, pnnMap);
    expect(Object.values(back.populations).some((pop) => pop.name.startsWith("Quadrant"))).toBe(false);
  });
});
