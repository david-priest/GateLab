// @vitest-environment jsdom
// A straight quadrant with its centre at (0, 0) on a log x axis, whose floor is display 0, by a
// biex y axis. Q1 (x below the divider) holds no event. It is written as the interval from 0 to
// 0, which holds no value for a Gating-ML reader or for GateLab reading the file back; written
// from -1.797e308 to -1.797e308, GateLab read 100 events at a stored 0 back into it.
import { describe, it, expect } from "vitest";
import type { FcsFile } from "./fcs";
import { Sample } from "./sample";
import { exportGatingML, GATINGML_EXPORT_CAPABILITIES } from "./gatingmlExport";
import { importGatingML, gatingMLImportOptionsFor } from "./gatingml";
import { applyGatingStrategy } from "./populations";
import { linkChildToParent, newGateRef, newPopulation, newRootPopulation, type Gate, type PopulationMap, type TransformSpec } from "./models";

function sample(): Sample {
  const n = 400;
  const fcs: FcsFile = {
    version: "FCS3.1", nEvents: n, instrument: "flow", keywords: {}, spillover: null,
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "FL2-A", marker: null, bits: 32, range: 262144 },
    ] as FcsFile["channels"],
    // FL2-A: 100 events exactly 0, 100 negative, 200 positive.
    columns: [
      Float32Array.from({ length: n }, (_, i) => 1000 + i * 100),
      Float32Array.from({ length: n }, (_, i) => (i < 100 ? 0 : i < 200 ? -50 - i : 10 * i)),
    ],
  };
  return new Sample(fcs);
}

const SPECS: Record<string, TransformSpec> = {
  flog: { kind: "flog", T: 262144, M: 4.5 },
  wsplog: { kind: "wsplog", offset: 1, decades: 4.5 },
};

describe("Gating-ML population element ID contract", () => {
  it("declares a frozen version 1 capability", () => {
    expect(GATINGML_EXPORT_CAPABILITIES).toEqual({ populationElementIds: 1 });
    expect(Object.isFrozen(GATINGML_EXPORT_CAPABILITIES)).toBe(true);
  });

  for (const format of ["standard", "cytobank"] as const) {
    it(`${format}: the map is empty when no non-root population is present`, () => {
      const root = newRootPopulation();
      const populationElementIds = new Map<string, string>();
      const control = {
        gate_id: "control", name: "control", gate_type: "rectangle", x_channel: "FSC-A", y_channel: "FL2-A",
        vertices: [[0, 0], [50000, 5000]], bounds: "closed", space: "raw", color: "#000", label_offset: null,
      } as Gate;
      const xml = exportGatingML({
        gates: { control }, gate_order: ["control"], populations: { [root.population_id]: root },
        root_population_id: root.population_id, sample: sample(), format, populationElementIds,
      });
      expect(new DOMParser().parseFromString(xml, "application/xml").getElementsByTagName("gating:RectangleGate")).toHaveLength(1);
      expect(Object.fromEntries(populationElementIds)).toEqual({});
    });

    it(`${format}: the map is empty when every population is explicitly omitted`, () => {
      const root = newRootPopulation();
      const quad = {
        gate_id: "q", name: "CD4_positive", gate_type: "quadrant", x_channel: "FSC-A", y_channel: "FL2-A",
        center: [2000, 0], curl: { power: 1.5, kx: 0.5, ky: 0.5 }, space: "raw", color: "#000", label_offset: null,
      } as unknown as Gate;
      const p = newPopulation("treated", [newGateRef("q", true, 2)], root.population_id);
      const populations = linkChildToParent({ [root.population_id]: root, [p.population_id]: p }, p.population_id, root.population_id);
      const populationElementIds = new Map<string, string>();
      const opts = { gates: { q: quad }, gate_order: ["q"], populations, root_population_id: root.population_id, sample: sample(), format, populationElementIds };
      expect(() => exportGatingML(opts)).toThrow(/explicitly accepting their omission/i);
      const xml = exportGatingML({ ...opts, allowQuadrantOmission: true });
      expect(xml).not.toContain("treated");
      expect(Object.fromEntries(populationElementIds)).toEqual({});
    });
  }
});

describe("quadrant divider on a log floor", () => {
  for (const [label, spec] of Object.entries(SPECS)) {
    for (const format of ["standard", "cytobank"] as const) {
      it(`${label} ${format}`, () => {
        const s = sample();
        const quad = {
          gate_id: "q", name: "CD4_positive", gate_type: "quadrant", x_channel: "FL2-A", y_channel: "FSC-A",
          center: [0, 0], space: "display", transforms: { "FL2-A": spec, "FSC-A": { kind: "biex", maxValue: 262144, pos: 4.5, neg: 0, widthBasis: -10, channelRange: 4096 } },
          color: "#000", label_offset: null,
        } as unknown as Gate;
        const root = newRootPopulation();
        let pops: PopulationMap = { [root.population_id]: root };
        for (let q = 1; q <= 4; q++) {
          const p = newPopulation(`Q${q}`, [newGateRef("q", true, q)], root.population_id);
          pops[p.population_id] = p;
          pops = linkChildToParent(pops, p.population_id, root.population_id);
        }
        const ws = { gates: { q: quad }, gate_order: ["q"], populations: pops, root_population_id: root.population_id };
        let xml: string;
        try { xml = exportGatingML({ ...ws, sample: s, format, timestamp: "t" }); }
        catch (e) { throw new Error(`${label} ${format} refused: ${(e as Error).message}`); }
        if (format === "standard") console.log(label, xml.split("\n").filter((l) => /gating:dimension |<name>/.test(l)).slice(0, 4).join("\n"));
        const back = importGatingML(xml, s.channels.map((c) => c.key), Object.fromEntries(s.channels.map((c) => [c.pnn, c.key])), "flow", gatingMLImportOptionsFor(s));
        const a = applyGatingStrategy(ws.gates, ws.populations, ws.root_population_id, s.gateAssayData()).masks;
        const b = applyGatingStrategy(back.gates, back.populations, back.root_population_id, s.gateAssayData()).masks;
        const cnt = (m: Uint8Array) => m.reduce((x, v) => x + v, 0);
        const rows: string[] = [];
        let differ = 0;
        for (const p of Object.values(ws.populations)) {
          if (p.population_id === root.population_id) continue;
          const q = Object.values(back.populations).find((z) => z.name === p.name)!;
          rows.push(`${p.name}: GateLab ${cnt(a[p.population_id])}, re-imported ${q ? cnt(b[q.population_id]) : "missing"}`);
          expect(q, `${label} ${format}: missing ${p.name}`).toBeDefined();
          expect(cnt(b[q.population_id]), `${p.name} count`).toBe(cnt(a[p.population_id]));
          for (let i = 0; i < s.fcs.nEvents; i++) if (a[p.population_id][i] !== b[q.population_id][i]) differ++;
        }
        expect(cnt(a[Object.values(ws.populations).find((p) => p.name === "Q1")!.population_id])).toBe(0);
        expect(cnt(a[Object.values(ws.populations).find((p) => p.name === "Q2")!.population_id])).toBe(400);
        expect(differ, `${label} ${format}: ${rows.join("; ")}`).toBe(0);
      });
    }
  }
});

describe("quadrant regions at and outside a biex clamp", () => {
  const biex: TransformSpec = { kind: "biex", maxValue: 262144, pos: 4.418539922, neg: 0, widthBasis: -10, channelRange: 256 };
  const points = [[-1, -700], [0, -100], [1, 0], [-1, 0], [0, 1e6], [1, 1e9], [NaN, 0], [1, NaN]];
  const cases = [
    { label: "floor", divider: 0, owners: [1, 2, 2, 1, 2, 2, null, null] },
    { label: "below floor", divider: -1, owners: [1, 2, 2, 1, 2, 2, null, null] },
    { label: "at ceiling", divider: 256, owners: [4, 3, 3, 4, 2, 2, null, null] },
    { label: "above ceiling", divider: 257, owners: [4, 3, 3, 4, 3, 3, null, null] },
  ];
  for (const { label, divider, owners } of cases) {
    for (const format of ["standard", "cytobank"] as const) {
      it(`${label} ${format}: all regions, helpers and NOT descendants are present and counted`, () => {
        const s = new Sample({
          version: "FCS3.1", nEvents: points.length, instrument: "flow", keywords: {}, spillover: null,
          channels: [
            { index: 0, name: "FL1-A", marker: null, bits: 32, range: 262144 },
            { index: 1, name: "FL2-A", marker: null, bits: 32, range: 262144 },
          ] as FcsFile["channels"],
          columns: [Float32Array.from(points, (p) => p[0]), Float32Array.from(points, (p) => p[1])],
        });
        const quad = {
          gate_id: "q", name: "CD4_positive", gate_type: "quadrant", x_channel: "FL1-A", y_channel: "FL2-A",
          center: [0, divider], space: "display", transforms: { "FL1-A": { kind: "identity" }, "FL2-A": biex },
          color: "#000", label_offset: null,
        } as unknown as Gate;
        const control = {
          gate_id: "control", name: "control", gate_type: "rectangle", x_channel: "FL1-A", y_channel: "FL2-A",
          vertices: [[-20, -20], [20, 20]], bounds: "closed", space: "raw", color: "#000", label_offset: null,
        } as Gate;
        const root = newRootPopulation();
        let pops: PopulationMap = { [root.population_id]: root };
        const expected = new Map<string, number[]>();
        const add = (name: string, refs: ReturnType<typeof newGateRef>[], want: number[], parent = root.population_id) => {
          const p = newPopulation(name, refs, parent);
          pops[p.population_id] = p;
          pops = linkChildToParent(pops, p.population_id, parent);
          expected.set(name, want);
          return p.population_id;
        };
        const insideControl = (i: number) => points[i][0] >= -20 && points[i][0] <= 20 && points[i][1] >= -20 && points[i][1] <= 20;
        for (let q = 1; q <= 4; q++) {
          add(`Q${q}`, [newGateRef("q", true, q)], owners.map((owner) => Number(owner === q)));
          const parent = add(`NOT Q${q}`, [newGateRef("q", false, q)], owners.map((owner) => Number(owner !== q)));
          add(`NOT Q${q} child`, [newGateRef("control")], owners.map((owner, i) => Number(owner !== q && insideControl(i))), parent);
        }
        add("mixed", [newGateRef("q", false, 1), newGateRef("q", false, 3)], owners.map((owner) => Number(owner !== 1 && owner !== 3)));
        add("empty", [newGateRef("q", true, 1), newGateRef("q", true, 2)], Array(points.length).fill(0));
        const ws = {
          gates: { q: quad, helper: { ...quad, gate_id: "helper", name: "CD4_helper" }, control },
          gate_order: ["q", "helper", "control"], populations: pops, root_population_id: root.population_id,
        };
        const source = applyGatingStrategy(ws.gates, pops, root.population_id, s.gateAssayData()).masks;
        for (const [name, want] of expected) {
          const p = Object.values(pops).find((p) => p.name === name)!;
          expect(Array.from(source[p.population_id]), `source ${name}`).toEqual(want);
        }
        const xml = exportGatingML({ ...ws, sample: s, format, timestamp: "t" });
        const doc = new DOMParser().parseFromString(xml, "application/xml");
        const regions = [...doc.getElementsByTagName(format === "standard" ? "gating:RectangleGate" : "gating:PolygonGate")];
        for (const name of ["CD4_positive", "CD4_helper"]) {
          expect(regions.map((el) => el.getElementsByTagName("name")[0]?.textContent).filter((value) => value?.startsWith(`${name} Q`)), `${name} exported regions`)
            .toEqual([1, 2, 3, 4].map((q) => `${name} Q${q}`));
        }
        const back = importGatingML(xml, s.channels.map((c) => c.key), Object.fromEntries(s.channels.map((c) => [c.pnn, c.key])), "flow", gatingMLImportOptionsFor(s));
        const returned = applyGatingStrategy(back.gates, back.populations, back.root_population_id, s.gateAssayData()).masks;
        const cnt = (m: Uint8Array) => m.reduce((sum, value) => sum + value, 0);
        expect(Object.values(back.populations).filter((p) => p.population_id !== back.root_population_id)).toHaveLength(expected.size);
        for (const [name, want] of expected) {
          const p = Object.values(back.populations).find((p) => p.name === name)!;
          expect(p, `missing ${name}`).toBeDefined();
          expect(cnt(returned[p.population_id]), `${name} count`).toBe(want.reduce((sum, value) => sum + value, 0));
          expect(Array.from(returned[p.population_id]), `re-imported ${name}`).toEqual(want);
        }
      });
    }
  }
});
