// @vitest-environment jsdom
//
// FlowJo 10's spider quadrant: four PolygonGates with quadId 0 to 3 beside one another, each the
// centre, its two arm ends and the plot corner between them, in raw units. Imported as one GateLab
// quadrant gate with leaning arms, written back the way FlowJo writes it, and read again. Synthetic
// channels, events and names throughout (sample D1).

import { describe, expect, it } from "vitest";
import { Sample } from "./sample";
import { flowJoWorkspaceToGatingML } from "./flowjoWorkspace";
import { importGatingML } from "./gatingml";
import { applyGatingStrategy } from "./populations";
import { exportFlowJoWorkspace } from "./flowjoExport";
import { WSP_POLYGON_ATTR } from "./polygonRecord";
import { armsLean, validArms, type Gate, type PopulationMap, type QuadrantGate, type Vertex } from "./models";
import type { FcsFile } from "./fcs";

const G = "http://www.isac-net.org/std/Gating-ML/v2.0/gating";
const D = "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes";
const T = "http://www.isac-net.org/std/Gating-ML/v2.0/transformations";

interface Tree { gates: Record<string, Gate>; gate_order: string[]; populations: PopulationMap; root_population_id: string }

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** D1: scatter spread over the linear axes, two fluorescence channels over a biex range. */
function d1(): FcsFile {
  const r = rng(20261022);
  const cols: number[][] = [[], [], [], []];
  for (let i = 0; i < 20000; i++) {
    cols[0].push(1000 + r() * 260000);
    cols[1].push(1000 + r() * 260000);
    cols[2].push(-300 + Math.exp(r() * 11));
    cols[3].push(-300 + Math.exp(r() * 11));
  }
  return {
    version: "FCS3.1", nEvents: cols[0].length, instrument: "flow", keywords: { $CYT: "Synthetic cytometer" },
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
      { index: 2, name: "FITC-A", marker: null, bits: 32, range: 262144 },
      { index: 3, name: "PE-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: cols.map((c) => Float32Array.from(c)),
    spillover: null,
  } as unknown as FcsFile;
}

const TRANSFORMS = `<Transformations>
    <transforms:linear transforms:minRange="0" transforms:maxRange="262144" gain="1"><data-type:parameter data-type:name="FSC-A"/></transforms:linear>
    <transforms:linear transforms:minRange="0" transforms:maxRange="262144" gain="1"><data-type:parameter data-type:name="SSC-A"/></transforms:linear>
    <transforms:biex transforms:length="256" transforms:maxRange="262144" transforms:neg="0" transforms:width="-100" transforms:pos="4.42"><data-type:parameter data-type:name="FITC-A"/></transforms:biex>
    <transforms:biex transforms:length="256" transforms:maxRange="262144" transforms:neg="0" transforms:width="-100" transforms:pos="4.42"><data-type:parameter data-type:name="PE-A"/></transforms:biex>
  </Transformations>`;

function workspace(subpopulations: string): string {
  return `<Workspace xmlns:transforms="${T}" xmlns:data-type="${D}" xmlns:gating="${G}"><SampleList><Sample>
  <DataSet uri="file:D1.fcs"/>
  ${TRANSFORMS}
  <SampleNode name="D1.fcs" count="20000"><Subpopulations>${subpopulations}</Subpopulations></SampleNode></Sample></SampleList></Workspace>`;
}

interface Spider { c: Vertex; down: Vertex; right: Vertex; up: Vertex; left: Vertex; box: [number, number, number, number] }

/** FlowJo's four panels for a spider, in its layout: [horizontal end, corner, vertical end, centre]. */
function panels(s: Spider): Record<number, Vertex[]> {
  const [x0, x1, y0, y1] = s.box;
  return {
    0: [s.left, [x0, y0], s.down, s.c],
    1: [s.right, [x1, y0], s.down, s.c],
    2: [s.left, [x0, y1], s.up, s.c],
    3: [s.right, [x1, y1], s.up, s.c],
  };
}

const PANEL_NAMES = ["D1 x- y-", "D1 x+ y-", "D1 x- y+", "D1 x+ y+"];

function panelPop(quadId: number, ring: Vertex[], x: string, y: string, inner = ""): string {
  return `<Population name="${PANEL_NAMES[quadId]}" count="1"><Gate>
    <gating:PolygonGate eventsInside="1" quadId="${quadId}" gateResolution="256" gating:id="q${quadId}">
      <gating:dimension><data-type:fcs-dimension data-type:name="${x}"/></gating:dimension>
      <gating:dimension><data-type:fcs-dimension data-type:name="${y}"/></gating:dimension>
      ${ring.map(([a, b]) => `<gating:vertex><gating:coordinate data-type:value="${a}"/><gating:coordinate data-type:value="${b}"/></gating:vertex>`).join("")}
    </gating:PolygonGate></Gate>${inner ? `<Subpopulations>${inner}</Subpopulations>` : ""}</Population>`;
}

function spiderPops(s: Spider, x: string, y: string, only: number[] = [0, 1, 2, 3], inner: Record<number, string> = {}): string {
  const p = panels(s);
  return only.map((q) => panelPop(q, p[q], x, y, inner[q])).join("");
}

function importXml(xml: string, sample: Sample): Tree & { warnings: string[] } {
  const conv = flowJoWorkspaceToGatingML(xml, 0, null, undefined, { flowJoGrid: true });
  const pnn: Record<string, string> = {};
  for (const c of sample.channels) pnn[c.pnn] = c.key;
  const res = importGatingML(conv.gatingMl, sample.channels.map((c) => c.key), pnn, sample.instrument);
  return { gates: res.gates, gate_order: res.gate_order, populations: res.populations, root_population_id: res.root_population_id, warnings: conv.warnings };
}

function masksByName(sample: Sample, tree: Tree): Map<string, Uint8Array> {
  const { masks } = applyGatingStrategy(tree.gates, tree.populations, tree.root_population_id, sample.gateAssayData());
  const out = new Map<string, Uint8Array>();
  for (const [pid, pop] of Object.entries(tree.populations)) if (pid !== tree.root_population_id) out.set(pop.name.split("/").pop()!, masks[pid]);
  return out;
}

const count = (m: Uint8Array | undefined) => (m ? m.reduce((n, v) => n + v, 0) : -1);
const differ = (a: Uint8Array, b: Uint8Array) => a.reduce((n, v, i) => n + (v !== b[i] ? 1 : 0), 0);
const quadrantGates = (t: Tree) => Object.values(t.gates).filter((g): g is QuadrantGate => g.gate_type === "quadrant");

// A spider on the linear scatter axes, every arm leaning, ends on FlowJo's axis edges.
const SCATTER: Spider = {
  c: [100000, 110000], down: [80000, 0], right: [262144, 130000], up: [60000, 262144], left: [0, 90000],
  box: [0, 262144, 0, 262144],
};

describe("a FlowJo spider quadrant on linear axes", () => {
  const sample = new Sample(d1());
  const tree = importXml(workspace(spiderPops(SCATTER, "FSC-A", "SSC-A")), sample);

  it("imports as one quadrant gate with the four arms FlowJo saved", () => {
    const quads = quadrantGates(tree);
    expect(quads).toHaveLength(1);
    expect(Object.keys(tree.gates)).toHaveLength(1);
    const q = quads[0];
    expect(q.center).toEqual(SCATTER.c);
    expect(q.arms).toEqual({ down: SCATTER.down, right: SCATTER.right, up: SCATTER.up, left: SCATTER.left });
    expect(validArms(q.center, q.arms)).toBe(true);
    // Each FlowJo population names its quadrant: quadId 0 x−/y− is GateLab's 4, 1 is 3, 2 is 1, 3 is 2.
    const byName = Object.fromEntries(Object.values(tree.populations).map((p) => [p.name, p.gate_refs]));
    expect(PANEL_NAMES.map((n) => byName[n].map((r) => r.quadrant))).toEqual([[4], [3], [1], [2]]);
  });

  it("holds exactly the events FlowJo's four panels hold, each event in one quadrant", () => {
    // The reading the import gave until now: each panel alone, as a polygon of its own.
    const p = panels(SCATTER);
    const alone = [0, 1, 2, 3].map((q) => importXml(workspace(panelPop(q, p[q], "FSC-A", "SSC-A")), new Sample(d1())));
    alone.forEach((t) => expect(quadrantGates(t)).toHaveLength(0));
    const spider = masksByName(sample, tree);
    let total = 0;
    PANEL_NAMES.forEach((name, q) => {
      const polygon = masksByName(new Sample(d1()), alone[q]).get(name)!;
      expect([name, differ(spider.get(name)!, polygon)]).toEqual([name, 0]);
      total += count(spider.get(name));
    });
    // Every event lies inside the box, so the four quadrants hold all of them between them.
    expect(total).toBe(20000);
    for (const name of PANEL_NAMES) expect([name, count(spider.get(name)) > 1000]).toEqual([name, true]);
  });

  it("writes it back as FlowJo writes one, and reads it back as the same gate holding the same events", () => {
    const before = masksByName(sample, tree);
    const xml = exportFlowJoWorkspace({ samples: [{ sample, fileName: "D1.fcs", ...tree }], now: new Date("2026-10-22T00:00:00Z") }).xml;
    const written = [...xml.matchAll(/<gating:PolygonGate[^>]*quadId="(\d)"/g)].map((m) => Number(m[1])).sort();
    expect(written).toEqual([0, 1, 2, 3]);
    for (const [label, file] of [
      ["with GateLab's records", xml],
      ["as FlowJo would save it, without them", xml.replace(new RegExp(` ${WSP_POLYGON_ATTR}="[^"]*"`, "g"), "")],
    ] as const) {
      const back = importXml(file, new Sample(d1()));
      const quads = quadrantGates(back);
      expect([label, quads.length]).toEqual([label, 1]);
      expect(armsLean(quads[0].center, quads[0].arms)).toBe(true);
      const after = masksByName(new Sample(d1()), back);
      for (const name of PANEL_NAMES) expect([label, name, differ(before.get(name)!, after.get(name)!)]).toEqual([label, name, 0]);
    }
  });
});

describe("a FlowJo spider quadrant on biex axes", () => {
  // Raw ends on FlowJo's axis edges; the arms are straight in FlowJo's biex display, not in raw.
  const BIEX: Spider = {
    c: [800, 1200], down: [400, -300], right: [262144, 3000], up: [3000, 262144], left: [-300, 600],
    box: [-300, 262144, -300, 262144],
  };
  const sample = new Sample(d1());
  const tree = importXml(workspace(spiderPops(BIEX, "FITC-A", "PE-A")), sample);

  it("is carried into the display FlowJo draws it in, its arms valid there", () => {
    const [q] = quadrantGates(tree);
    expect(q.space).toBe("display");
    expect(q.transforms?.["FITC-A"]?.kind).toBe("biex");
    expect(validArms(q.center, q.arms)).toBe(true);
    expect(armsLean(q.center, q.arms)).toBe(true);
  });

  it("holds the events each panel alone holds", () => {
    const p = panels(BIEX);
    const spider = masksByName(sample, tree);
    PANEL_NAMES.forEach((name, q) => {
      const alone = importXml(workspace(panelPop(q, p[q], "FITC-A", "PE-A")), new Sample(d1()));
      const polygon = masksByName(new Sample(d1()), alone).get(name)!;
      expect(count(polygon)).toBeGreaterThan(100);
      expect([name, differ(spider.get(name)!, polygon)]).toEqual([name, 0]);
    });
  });

  it("comes back from its own export as the same gate", () => {
    const before = masksByName(sample, tree);
    const xml = exportFlowJoWorkspace({ samples: [{ sample, fileName: "D1.fcs", ...tree }], now: new Date("2026-10-22T00:00:00Z") }).xml;
    const back = importXml(xml, new Sample(d1()));
    const [q] = quadrantGates(back);
    const [orig] = quadrantGates(tree);
    expect(q.center[0]).toBeCloseTo(orig.center[0], 9);
    expect(q.center[1]).toBeCloseTo(orig.center[1], 9);
    const after = masksByName(new Sample(d1()), back);
    for (const name of PANEL_NAMES) expect([name, differ(before.get(name)!, after.get(name)!)]).toEqual([name, 0]);
  });
});

describe("FlowJo quadId panels that do not make a spider", () => {
  it.each([
    ["three panels", workspace(spiderPops(SCATTER, "FSC-A", "SSC-A", [0, 1, 2]))],
    ["panels whose centres differ", workspace(spiderPops(SCATTER, "FSC-A", "SSC-A", [0, 1, 2]) + spiderPops({ ...SCATTER, c: [100001, 110000] }, "FSC-A", "SSC-A", [3]))],
    ["panels on another pair of axes", workspace(spiderPops(SCATTER, "FSC-A", "SSC-A", [0, 1, 2]) + spiderPops(SCATTER, "FSC-A", "FITC-A", [3]))],
  ])("import as the polygons FlowJo wrote: %s", (_why, xml) => {
    const tree = importXml(xml, new Sample(d1()));
    expect(quadrantGates(tree)).toHaveLength(0);
    expect(Object.values(tree.gates).every((g) => g.gate_type === "polygon")).toBe(true);
  });
});

describe("populations beneath and beside a spider quadrant", () => {
  const under = `<Population name="D1 under" count="1"><Gate>
    <gating:RectangleGate gating:id="u1">
      <gating:dimension gating:min="0" gating:max="131072"><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
      <gating:dimension gating:min="0" gating:max="262144"><data-type:fcs-dimension data-type:name="SSC-A"/></gating:dimension>
    </gating:RectangleGate></Gate></Population>`;
  const not = `<NotNode name="D1 not x- y-" count="1"><Gate>
    <gating:RectangleGate gating:id="stale"><gating:dimension gating:min="0"><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
    <gating:dimension gating:min="0"><data-type:fcs-dimension data-type:name="SSC-A"/></gating:dimension></gating:RectangleGate></Gate>
    <Dependents><Dependent name="${PANEL_NAMES[0]}"/></Dependents></NotNode>`;
  const and = `<AndNode name="D1 x+ y+ and low FSC" count="1"><Dependents>
    <Dependent name="${PANEL_NAMES[3]}"/><Dependent name="D1 low FSC"/></Dependents></AndNode>`;
  const low = `<Population name="D1 low FSC" count="1"><Gate>
    <gating:RectangleGate gating:id="low">
      <gating:dimension gating:min="0" gating:max="150000"><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
    </gating:RectangleGate></Gate></Population>`;
  const sample = new Sample(d1());
  const tree = importXml(workspace(spiderPops(SCATTER, "FSC-A", "SSC-A", [0, 1, 2, 3], { 3: under }) + not + and + low), sample);
  const byName = (n: string) => Object.values(tree.populations).find((p) => p.name === n)!;
  const masks = masksByName(sample, tree);

  it("keeps what FlowJo gated beneath a panel beneath that quadrant", () => {
    expect(byName("D1 under").parent_id).toBe(byName(PANEL_NAMES[3]).population_id);
    expect(count(masks.get("D1 under"))).toBeLessThan(count(masks.get(PANEL_NAMES[3])));
  });

  it("names the quadrant in a complement or an intersection of a panel", () => {
    const [q] = quadrantGates(tree);
    expect(byName("D1 not x- y-").gate_refs).toEqual([{ gate_id: q.gate_id, include: false, quadrant: 4 }]);
    expect(byName("D1 x+ y+ and low FSC").gate_refs).toContainEqual({ gate_id: q.gate_id, include: true, quadrant: 2 });
    expect(count(masks.get("D1 not x- y-"))).toBe(20000 - count(masks.get(PANEL_NAMES[0])));
    const both = masks.get(PANEL_NAMES[3])!.reduce((n, v, i) => n + (v && masks.get("D1 low FSC")![i] ? 1 : 0), 0);
    expect(count(masks.get("D1 x+ y+ and low FSC"))).toBe(both);
  });
});

describe("a spider quadrant beneath a node the import skips", () => {
  // A NOT of two populations is refused by name, with everything beneath it; here that is a spider
  // quadrant's four panels. Its shared gate goes with them, and a NOT elsewhere naming one of its
  // quadrants is refused, where the gate was left behind naming a parent that was never written
  // and the whole workspace failed to import.
  const panelsBeneath = spiderPops(SCATTER, "FSC-A", "SSC-A");
  const kept = `<Population name="D1 kept" count="1"><Gate>
    <gating:RectangleGate gating:id="kept">
      <gating:dimension gating:min="0" gating:max="150000"><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
    </gating:RectangleGate></Gate></Population>`;
  const refused = `<NotNode name="D1 refused" count="1"><Dependents>
    <Dependent name="D1 kept"/><Dependent name="D1 other"/></Dependents>
    <Subpopulations>${panelsBeneath}</Subpopulations></NotNode>`;
  const other = `<Population name="D1 other" count="1"><Gate>
    <gating:RectangleGate gating:id="other">
      <gating:dimension gating:min="0" gating:max="262144"><data-type:fcs-dimension data-type:name="SSC-A"/></gating:dimension>
    </gating:RectangleGate></Gate></Population>`;
  const namesPanel = `<NotNode name="D1 not a panel" count="1"><Dependents>
    <Dependent name="D1 refused/${PANEL_NAMES[0]}"/></Dependents></NotNode>`;

  it("leaves the gate out with its populations, refuses what names one, and imports the rest", () => {
    const conv = flowJoWorkspaceToGatingML(workspace(kept + other + refused + namesPanel), 0, null, undefined, { flowJoGrid: true });
    expect(conv.gatingMl).not.toContain("gatelab_spider_quadrant");
    expect(conv.warnings.some((w) => /"D1 refused"/.test(w) && /4 population/.test(w))).toBe(true);
    expect(conv.warnings.some((w) => /"D1 not a panel"/.test(w) && /skipped/.test(w))).toBe(true);
    const tree = importXml(workspace(kept + other + refused + namesPanel), new Sample(d1()));
    expect(quadrantGates(tree)).toHaveLength(0);
    const names = Object.values(tree.populations).map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(["D1 kept", "D1 other"]));
    for (const n of [...PANEL_NAMES, "D1 refused", "D1 not a panel"]) expect(names).not.toContain(n);
  });
});

