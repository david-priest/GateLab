// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { FcsFile } from "./fcs";
import { Sample } from "./sample";
import { analyzeGatingMLRewrites, exportGatingML, type GatingMLFormat } from "./gatingmlExport";
import { importGatingML } from "./gatingml";
import { applyGatingStrategy } from "./populations";
import { linkChildToParent, newGateRef, newPopulation, newRootPopulation, type Gate, type PopulationMap, type TransformSpec } from "./models";

/** A seeded uniform generator, so the synthetic file is the same on every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Synthetic flow file D1.fcs: scatter and three fluorescence channels, each with a negative and a positive population. */
function syntheticSample(n = 1500): Sample {
  const u = prng(3);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
  const marker = (mid: number) => () => (u() < 0.5 ? Math.exp(Math.log(mid) + 0.6 * gauss()) : 200 * gauss());
  const fl = [marker(8000), marker(5000), marker(12000)];
  const cols = [[], [], [], []] as number[][];
  for (let i = 0; i < n; i++) {
    cols[0].push(30000 + 150000 * u());
    fl.forEach((f, k) => cols[k + 1].push(f()));
  }
  const ch = (index: number, name: string) => ({ index, name, marker: null, bits: 32, range: 262144 });
  const fcs: FcsFile = {
    version: "FCS3.1", nEvents: n, instrument: "flow", keywords: {}, spillover: null,
    channels: [ch(0, "FSC-A"), ch(1, "FL1-A"), ch(2, "FL2-A"), ch(3, "FL3-A")],
    columns: cols.map((c) => Float32Array.from(c)),
  };
  return new Sample(fcs);
}

const LOGICLE: TransformSpec = { kind: "logicle", T: 262144, W: 0.5, M: 4.5, A: 0 };
const BIEX: TransformSpec = { kind: "biex", maxValue: 262144, pos: 4.5, neg: 0, widthBasis: -10, channelRange: 256 };
const GRID: TransformSpec = { kind: "flowjoChannels", channels: 256, axis: { kind: "linear", minRange: 0, maxRange: 262144 } };

/** One gate of each kind on each kind of axis, each with a population of its own beneath the root. */
function workspace(sample: Sample) {
  const key = (pnn: string) => sample.channels.find((c) => c.pnn === pnn)!.key;
  const [fsc, fl1, fl2, fl3] = ["FSC-A", "FL1-A", "FL2-A", "FL3-A"].map(key);
  const base = { color: "#377eb8", label_offset: null };
  const shape = (name: string, x: string, y: string, tx: TransformSpec | null, ty: TransformSpec | null, rest: object): Gate => ({
    gate_id: `gate_${name}`, name, x_channel: x, y_channel: y, ...base,
    ...(tx && ty ? { space: "display", transforms: { [x]: tx, [y]: ty } } : { space: "raw" }),
    ...rest,
  } as Gate);
  const rect = (lo: number, hi: number) => ({ gate_type: "rectangle", vertices: [[lo, lo], [hi, lo], [hi, hi], [lo, hi]], bounds: "half-open" });
  const poly = (vs: [number, number][]) => ({ gate_type: "polygon", vertices: vs });
  const ell = (m: number, v: number) => ({ gate_type: "ellipse", mean: [m, m], covariance: [[v, v / 3], [v / 3, v]], distance_square: 1 });
  const gates = [
    shape("CD4_positive", fl1, fl2, LOGICLE, LOGICLE, rect(0.55, 0.9)),
    shape("CD8_positive", fl1, fl2, LOGICLE, LOGICLE, poly([[0.3, 0.3], [0.8, 0.35], [0.7, 0.85], [0.35, 0.7]])),
    shape("CD3_positive", fl1, fl2, LOGICLE, LOGICLE, ell(0.6, 0.01)),
    shape("Lymphocytes", fl1, fl3, BIEX, BIEX, poly([[60, 60], [200, 80], [180, 220], [70, 190]])),
    shape("Monocytes", fl1, fl3, BIEX, BIEX, rect(100, 200)),
    shape("B_cells", fl1, fl3, BIEX, BIEX, ell(150, 400)),
    shape("Grid_cells", fl2, fl3, GRID, GRID, poly([[10, 10], [120, 30], [100, 140], [20, 100]])),
    shape("Mixed", fl2, fl3, LOGICLE, BIEX, poly([[0.3, 60], [0.8, 80], [0.7, 220], [0.35, 190]])),
    shape("Singlets", fsc, fl1, null, null, poly([[40000, -100], [160000, -100], [160000, 50000], [40000, 50000]])),
  ];
  const root = newRootPopulation();
  let populations: PopulationMap = { [root.population_id]: root };
  for (const g of gates) {
    const p = newPopulation(`${g.name}_cells`, [newGateRef(g.gate_id, true)], root.population_id);
    populations[p.population_id] = p;
    populations = linkChildToParent(populations, p.population_id, root.population_id);
  }
  return {
    gates: Object.fromEntries(gates.map((g) => [g.gate_id, g])), gate_order: gates.map((g) => g.gate_id),
    populations, root_population_id: root.population_id,
  };
}

/** The element a gate is written as, found by its gating:id, which ends in the gate's name in Cytobank's base64. */
function gateElement(xml: string, name: string): string {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const id = `_${btoa(name).replace(/\+/g, "_").replace(/\//g, "-").replace(/=/g, ".")}`;
  const el = [...doc.documentElement.children].find((e) => e.localName !== "BooleanGate" && e.getAttribute("gating:id")?.endsWith(id));
  if (!el) throw new Error(`no element for ${name}`);
  return new XMLSerializer().serializeToString(el);
}

describe("analyzeGatingMLRewrites", () => {
  const sample = syntheticSample();
  const ws = workspace(sample);

  it("names the gates the Cytobank format writes on arcsinh axes, and none in the standard format", () => {
    const cytobank = analyzeGatingMLRewrites({ ...ws, sample, format: "cytobank" });
    const standard = analyzeGatingMLRewrites({ ...ws, sample, format: "standard" });
    expect(cytobank.arcsinh.names).toEqual(["CD4_positive", "CD8_positive", "CD3_positive", "Mixed"]);
    expect(standard.arcsinh.names).toEqual([]);
    // As written: each named gate declares arcsinh in the Cytobank file, and logicle in the standard one.
    const cxml = exportGatingML({ ...ws, sample, format: "cytobank", timestamp: "t" });
    const sxml = exportGatingML({ ...ws, sample, format: "standard", timestamp: "t" });
    expect(cxml).not.toContain("transforms:logicle");
    for (const name of cytobank.arcsinh.names) {
      expect(gateElement(cxml, name), name).toMatch(/transformation-ref="Tr_Fasinh_150"/);
      expect(gateElement(sxml, name), name).toMatch(/transformation-ref="Tr_Logicle_/);
    }
  });

  it("names the polygons and ellipses written in raw units with added vertices, in both formats", () => {
    for (const format of ["standard", "cytobank"] as GatingMLFormat[]) {
      const r = analyzeGatingMLRewrites({ ...ws, sample, format });
      // Not the biex rectangle, written in raw units exactly, nor the raw polygon.
      expect(r.densified.names, format).toEqual(["Lymphocytes", "B_cells", "Mixed"]);
      expect(r.gridCells.names, format).toEqual(["Grid_cells"]);
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "t" });
      const vertices = (name: string) => (gateElement(xml, name).match(/<gating:vertex>/g) ?? []).length;
      expect(vertices("Lymphocytes")).toBeGreaterThan(4);
      // The ellipse goes out as a polygon.
      expect(gateElement(xml, "B_cells")).toMatch(/PolygonGate/);
      expect(vertices("Singlets")).toBe(4);
      expect(gateElement(xml, "Monocytes")).toMatch(/RectangleGate/);
    }
  });

  it("leaves the exported file unchanged", () => {
    for (const format of ["standard", "cytobank"] as GatingMLFormat[]) {
      const before = exportGatingML({ ...ws, sample, format, timestamp: "t" });
      analyzeGatingMLRewrites({ ...ws, sample, format });
      analyzeGatingMLRewrites({ ...ws, sample, format: format === "standard" ? "cytobank" : "standard" });
      const after = exportGatingML({ ...ws, sample, format, timestamp: "t" });
      expect(after).toBe(before);
    }
  });

  it("writes gates that hold the drawn gates' events, read back by GateLab", () => {
    const counts = (w: { gates: Record<string, Gate>; populations: PopulationMap; root_population_id: string }) => {
      const masks = applyGatingStrategy(w.gates, w.populations, w.root_population_id, sample.gateAssayData()).masks;
      return Object.fromEntries(Object.values(w.populations).filter((p) => p.population_id !== w.root_population_id)
        .map((p) => [p.name, masks[p.population_id].reduce((n: number, v: number) => n + v, 0)]));
    };
    const drawn = counts(ws);
    expect(Object.values(drawn).every((n) => n > 0)).toBe(true);
    for (const format of ["standard", "cytobank"] as GatingMLFormat[]) {
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "t" });
      const back = importGatingML(xml, sample.channelNames(), Object.fromEntries(sample.channels.map((c) => [c.pnn, c.key])), "flow");
      expect(counts(back), format).toEqual(drawn);
    }
  });
});
