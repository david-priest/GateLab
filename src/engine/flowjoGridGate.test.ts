// @vitest-environment jsdom
//
// A gate on FlowJo's grid keeps its rule everywhere a gate goes: the Gating-ML export (as the
// union of its cells, which every reader selects the same events from, with GateLab's mark), the
// FlowJo export (FlowJo's own raw vertices and gateResolution, onto the axis it was gridded on), a
// saved workspace, the R host's reader, an edit, and the badge. Synthetic names throughout.

import { describe, expect, it } from "vitest";
import { flowJoWorkspaceToGatingML } from "./flowjoWorkspace";
import { gatingMLImportOptionsFor, importGatingML } from "./gatingml";
import { gatingMlGains } from "./gatingmlGain";
import { exportGatingML } from "./gatingmlExport";
import { exportFlowJoWorkspace } from "./flowjoExport";
import { Sample } from "./sample";
import { applyGatingStrategy } from "./populations";
import { gateSpaceBadge } from "./gateSpaceBadge";
import { exportHierarchyCsv } from "./barcodeScheme";
import { packWorkspaceReference, readWorkspaceBytes, type WorkspaceFile } from "./workspace";
import { FLOAT32_MAX, flowJoGridEdges, flowJoGridScale, isFlowJoGridGate, type FlowJoGridSpec } from "./flowjoGrid";
import { biexTransform } from "./biex";
import type { FcsFile } from "./fcs";
import type { Gate, PolyRectGate, PopulationMap, TransformSpec, Vertex } from "./models";

const G = "http://www.isac-net.org/std/Gating-ML/v2.0/gating";
const D = "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes";
const T = "http://www.isac-net.org/std/Gating-ML/v2.0/transformations";

const RAW_VERTICES: Vertex[] = [[20000, -150], [200000, 40], [180000, 150000], [40000, 90000]];
const wspFor = (vertices: readonly Vertex[]): string => `<Workspace xmlns:transforms="${T}" xmlns:data-type="${D}" xmlns:gating="${G}"><SampleList><Sample>
  <DataSet uri="file:D1.fcs"/>
  <Transformations>
    <transforms:linear transforms:minRange="0" transforms:maxRange="262144" transforms:gain="1"><data-type:parameter data-type:name="FSC-A"/></transforms:linear>
    <transforms:biex transforms:length="256" transforms:maxRange="262144" transforms:neg="0" transforms:width="-10" transforms:pos="4.41854"><data-type:parameter data-type:name="B-A"/></transforms:biex>
  </Transformations>
  <SampleNode name="D1.fcs" count="10"><Subpopulations>
    <Population name="CD4_positive" count="5"><Gate>
      <gating:PolygonGate eventsInside="1" quadId="-1" gateResolution="256" gating:id="g1">
        <gating:dimension><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
        <gating:dimension><data-type:fcs-dimension data-type:name="B-A"/></gating:dimension>
        ${vertices.map(([x, y]) => `<gating:vertex><gating:coordinate data-type:value="${x}"/><gating:coordinate data-type:value="${y}"/></gating:vertex>`).join("")}
      </gating:PolygonGate></Gate></Population>
  </Subpopulations></SampleNode></Sample></SampleList></Workspace>`;

/** The float32 next to a number, above and below. */
function step32(f: number, dir: 1 | -1): number {
  const a = new Float32Array([f]);
  const u = new Uint32Array(a.buffer);
  if (a[0] === 0) { u[0] = dir > 0 ? 1 : 0x80000001; return a[0]; }
  if ((a[0] > 0) === (dir > 0)) u[0] += 1; else u[0] -= 1;
  return a[0];
}
const up32 = (v: number): number => { const f = Math.fround(v); return f > v ? f : step32(f, 1); };
const down32 = (v: number): number => { const f = Math.fround(v); return f < v ? f : step32(f, -1); };

/** Both corners of every other grid cell, and events far beyond both ends: where the rule bites. */
function eventsFor(sx: FlowJoGridSpec, sy: FlowJoGridSpec): FcsFile {
  const ex = flowJoGridEdges(sx);
  const ey = flowJoGridEdges(sy);
  const ends = (e: Float64Array, c: number): number[] => [c === 0 ? -1e9 : up32(e[c]), c === 255 ? 1e9 : down32(e[c + 1])];
  const xs: number[] = [];
  const ys: number[] = [];
  for (let cx = 0; cx < 256; cx += 2) for (let cy = 0; cy < 256; cy += 2) {
    for (const a of ends(ex, cx)) for (const b of ends(ey, cy)) { xs.push(a); ys.push(b); }
  }
  return {
    version: "FCS3.1", nEvents: xs.length, instrument: "flow", keywords: {},
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "B-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [Float32Array.from(xs), Float32Array.from(ys)],
    spillover: null,
  } as unknown as FcsFile;
}

interface Tree { gates: Record<string, Gate>; gate_order: string[]; populations: PopulationMap; root_population_id: string }

function importedTree(
  vertices: readonly Vertex[] = RAW_VERTICES, edit: (wsp: string) => string = (w) => w,
): { tree: Tree; gate: PolyRectGate; sample: Sample } {
  const conv = flowJoWorkspaceToGatingML(edit(wspFor(vertices)), 0, null, undefined, { flowJoGrid: true });
  const res = importGatingML(conv.gatingMl, ["FSC-A", "B-A"], {}, "flow");
  const gate = Object.values(res.gates)[0] as PolyRectGate;
  const sx = gate.transforms!["FSC-A"] as FlowJoGridSpec;
  const sy = gate.transforms!["B-A"] as FlowJoGridSpec;
  const sample = new Sample(eventsFor(sx, sy));
  return { tree: { gates: res.gates, gate_order: res.gate_order, populations: res.populations, root_population_id: res.root_population_id }, gate, sample };
}

function maskOf(sample: Sample, tree: Tree): Uint8Array {
  const { masks } = applyGatingStrategy(tree.gates, tree.populations, tree.root_population_id, sample.gateAssayData());
  const pid = Object.keys(tree.populations).find((id) => id !== tree.root_population_id)!;
  return masks[pid];
}
const differ = (a: Uint8Array, b: Uint8Array): number => a.reduce((n, v, i) => n + (v !== b[i] ? 1 : 0), 0);
const treeOf = (res: ReturnType<typeof importGatingML>): Tree => ({ gates: res.gates, gate_order: res.gate_order, populations: res.populations, root_population_id: res.root_population_id });

describe("a FlowJo grid gate exported to Gating-ML", () => {
  for (const format of ["standard", "cytobank"] as const) {
    it(`is written as the union of its cells, in raw units, with GateLab's mark (${format})`, () => {
      const { tree, gate, sample } = importedTree();
      const xml = exportGatingML({ ...tree, sample, format, allowQuadrantOmission: true });
      const polygon = xml.match(/<gating:PolygonGate[\s\S]*?<\/gating:PolygonGate>/)![0];
      expect(polygon).toContain("<gatelab_flowjo_grid>");
      expect(polygon).not.toContain("transformation-ref");
      // A rectilinear ring: every edge is horizontal or vertical.
      const values = [...polygon.matchAll(/data-type:value="([^"]+)"/g)].map((m) => Number(m[1]));
      const ring: Vertex[] = [];
      for (let i = 0; i + 1 < values.length; i += 2) ring.push([values[i], values[i + 1]]);
      expect(ring.length).toBeGreaterThan(gate.vertices.length);
      for (let i = 0; i < ring.length; i++) {
        const [a, b] = [ring[i], ring[(i + 1) % ring.length]];
        expect(a[0] === b[0] || a[1] === b[1]).toBe(true);
      }
    });

    it(`comes back into GateLab as the grid gate it was, the same events in it (${format})`, () => {
      const { tree, gate, sample } = importedTree();
      const before = maskOf(sample, tree);
      const xml = exportGatingML({ ...tree, sample, format, allowQuadrantOmission: true });
      const pnn: Record<string, string> = {};
      for (const c of sample.channels) pnn[c.pnn] = c.key;
      const res = importGatingML(xml, sample.channels.map((c) => c.key), pnn, "flow");
      const back = Object.values(res.gates)[0] as PolyRectGate;
      expect(isFlowJoGridGate(back)).toBe(true);
      expect(back.vertices).toEqual(gate.vertices);
      expect(back.transforms).toEqual(gate.transforms);
      expect(back.flowjo_vertices).toEqual(RAW_VERTICES);
      expect(differ(before, maskOf(sample, treeOf(res)))).toBe(0);
    });

    it(`selects the same events from the ring alone, when the mark is gone (${format})`, () => {
      const { tree, sample } = importedTree();
      const before = maskOf(sample, tree);
      expect(before.reduce((s, v) => s + v, 0)).toBeGreaterThan(100);
      const xml = exportGatingML({ ...tree, sample, format, allowQuadrantOmission: true })
        .replace(/<gatelab_flowjo_grid>[\s\S]*?<\/gatelab_flowjo_grid>/, "");
      const pnn: Record<string, string> = {};
      for (const c of sample.channels) pnn[c.pnn] = c.key;
      const res = importGatingML(xml, sample.channels.map((c) => c.key), pnn, "flow");
      const back = Object.values(res.gates)[0] as PolyRectGate;
      expect(back.space).toBe("raw");
      expect(differ(before, maskOf(sample, treeOf(res)))).toBe(0);
    });
  }

  // The ring's outer edges hold every event beyond the axis and stand for no bound: Cytobank's
  // scale block, derived from the written vertices, spanned about 1e38 when it took them.
  it("scales Cytobank's block to the ring's finite corners, not its outer edges", () => {
    // Reaching past both ends of both axes on one side: the ring runs out to its outer edges.
    const { tree, sample } = importedTree([[20000, -1e7], [5e8, -1e7], [5e8, 5e8], [40000, 90000]]);
    const xml = exportGatingML({ ...tree, sample, format: "cytobank", allowQuadrantOmission: true });
    const polygon = xml.match(/<gating:PolygonGate[\s\S]*?<\/gating:PolygonGate>/)![0];
    const values = [...polygon.matchAll(/data-type:value="([^"]+)"/g)].map((m) => Number(m[1]));
    // The outer edges, at 15 significant digits: just above the largest float32, which a reader
    // parsing float32 rounds to that float32, never to Infinity.
    const outer = Math.max(...values.map(Math.abs));
    expect(outer).toBeGreaterThanOrEqual(FLOAT32_MAX);
    expect(Math.fround(outer)).toBe(FLOAT32_MAX);
    const def = JSON.parse(polygon.match(/<definition>([\s\S]*?)<\/definition>/)![1].replace(/&quot;/g, '"'));
    // The file's events reach ±1e9 (eventsFor), and the scale covers them; it went to about 1e38.
    for (const axis of ["x", "y"]) {
      expect(Math.abs(def.scale[axis].min), axis).toBeLessThan(1e10);
      expect(Math.abs(def.scale[axis].max), axis).toBeLessThan(1e10);
    }
  });

  // The interoperability tester's version 5 probes each ring at the largest float32 (#347): an
  // event there, beyond the axis, is on the top channel, which the gate below holds. With the ring's
  // outer edge at exactly the largest float32 the event lay on the ring's right or upper edge, which
  // FlowKit's polygon test drops (238 and 485 probe values of the corpus's G8_tops and
  // G9_linear_ends, and 1 to 130 of each generated grid workspace's rings).
  it("keeps an event at the largest float32 strictly inside the ring, for a reader that drops a polygon's right and upper edges", () => {
    // Past both ends of both axes but the left: every channel from FSC-A 20000 up.
    const { tree } = importedTree([[20000, -1e7], [5e8, -1e7], [5e8, 5e8], [20000, 5e8]]);
    const xs = [FLOAT32_MAX, FLOAT32_MAX, 150000, 150000, -FLOAT32_MAX];
    const ys = [1000, FLOAT32_MAX, FLOAT32_MAX, 1000, 1000];
    const fcs = {
      version: "FCS3.1", nEvents: xs.length, instrument: "flow", keywords: {},
      channels: [
        { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
        { index: 1, name: "B-A", marker: null, bits: 32, range: 262144 },
      ],
      columns: [Float32Array.from(xs), Float32Array.from(ys)],
      spillover: null,
    } as unknown as FcsFile;
    const sample = new Sample(fcs);
    const held = maskOf(sample, tree);
    expect(Array.from(held.slice(0, 4))).toEqual([1, 1, 1, 1]);
    for (const format of ["standard", "cytobank"] as const) {
      const xml = exportGatingML({ ...tree, sample, format, allowQuadrantOmission: true });
      const polygon = xml.match(/<gating:PolygonGate[\s\S]*?<\/gating:PolygonGate>/)![0];
      const values = [...polygon.matchAll(/data-type:value="([^"]+)"/g)].map((m) => Number(m[1]));
      const ring: Vertex[] = [];
      for (let i = 0; i + 1 < values.length; i += 2) ring.push([values[i], values[i + 1]]);
      // A float32 reader reads the outer edge as the largest float32, a finite ring.
      const outer = Math.max(...values.map(Math.abs));
      expect(outer, format).toBeGreaterThan(FLOAT32_MAX);
      expect(Math.fround(outer), format).toBe(FLOAT32_MAX);
      // The crossing test FlowKit's matches on an edge: a point on a right or upper edge is outside.
      const halfOpen = (x: number, y: number): number => {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [xi, yi] = ring[i];
          const [xj, yj] = ring[j];
          if ((yi > y) !== (yj > y) && x < xi + ((y - yi) * (xj - xi)) / (yj - yi)) inside = !inside;
        }
        return inside ? 1 : 0;
      };
      expect(xs.map((x, i) => halfOpen(Math.fround(x), Math.fround(ys[i]))), format).toEqual(Array.from(held));
    }
  });

  // An FCS $DATATYPE I channel is held as exact integers, which float32 cannot hold above 2^24:
  // edges placed between two float32 values could fall on an integer, or on the wrong side of one.
  it("places the ring's edges halfway between two integers on an integer column", () => {
    const { tree, gate } = importedTree();
    const sx = gate.transforms!["FSC-A"] as FlowJoGridSpec;
    const gxs = flowJoGridScale(sx);
    // Integers on both sides of every FSC-A channel boundary; B-A across its whole range.
    const firsts: number[] = [];
    for (let c = 1; c < gxs.cells; c++) {
      let lo = -1e7;
      let hi = 1e7;
      while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (gxs.eventCell(mid) >= c) hi = mid; else lo = mid; }
      firsts.push(hi);
    }
    const xs: number[] = [];
    const ys: number[] = [];
    const yVals = [-200, -120, 0, 35, 40, 41, 800, 5000, 60000, 90000, 150000, 262143];
    for (const k of firsts) for (const d of [-1, 0]) for (const y of yVals) { xs.push(k + d); ys.push(y); }
    const fcs: FcsFile = {
      version: "FCS3.1", nEvents: xs.length, instrument: "flow", keywords: {},
      channels: [
        { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
        { index: 1, name: "B-A", marker: null, bits: 32, range: 262144 },
      ],
      columns: [Float64Array.from(xs), Float64Array.from(ys)],
      spillover: null,
    } as unknown as FcsFile;
    const sample = new Sample(fcs);
    expect(sample.rawPrecision("FSC-A")).toBe("float64");
    const before = maskOf(sample, tree);
    const n = before.reduce((a, v) => a + v, 0);
    expect(n).toBeGreaterThan(20);
    expect(n).toBeLessThan(before.length);
    const xml = exportGatingML({ ...tree, sample, format: "standard", allowQuadrantOmission: true });
    const polygon = xml.match(/<gating:PolygonGate[\s\S]*?<\/gating:PolygonGate>/)![0];
    const values = [...polygon.matchAll(/data-type:value="([^"]+)"/g)].map((m) => Number(m[1]));
    const finite = values.filter((v, i) => i % 2 === 0 && Math.abs(v) < FLOAT32_MAX);
    expect(finite.length).toBeGreaterThan(0);
    for (const v of finite) expect(v - Math.floor(v)).toBe(0.5);
    expect(differ(before, maskOf(sample, ringAlone(tree, sample, "standard")))).toBe(0);
  });

  // A float64 column that is not integral ($DATATYPE D, a decoded log channel): the edge is the
  // first double of the next channel, so an event on a channel's first value lies on the ring's left
  // or lower edge, which the half-open test FlowKit applies holds, and one a double below it lies
  // outside. Written to 15 significant digits, an edge could move past that first double, and the
  // event on it then fell outside the ring for every reader but GateLab.
  it("writes a float64 column's ring edges as the doubles they are, each channel's first value inside", () => {
    // A linear range whose channel boundaries are not short decimals, and B-A's biex table.
    const { tree, gate } = importedTree(RAW_VERTICES, (w) => w.replace('transforms:minRange="0" transforms:maxRange="262144"', 'transforms:minRange="-111.37" transforms:maxRange="261999.13"'));
    const sx = gate.transforms!["FSC-A"] as FlowJoGridSpec;
    const sy = gate.transforms!["B-A"] as FlowJoGridSpec;
    const ex = flowJoGridEdges(sx, "float64");
    const ey = flowJoGridEdges(sy, "float64");
    const below = (v: number): number => {
      const f = new Float64Array([v]);
      const b = new BigInt64Array(f.buffer);
      b[0] += v > 0 ? -1n : 1n;
      return f[0];
    };
    // Each channel's first value and the double below it, on every third boundary of both axes.
    const at = (e: Float64Array): number[] => {
      const out: number[] = [];
      for (let c = 1; c < e.length - 1; c += 3) if (Math.abs(e[c]) < FLOAT32_MAX) out.push(e[c], below(e[c]));
      return out;
    };
    const xs: number[] = [];
    const ys: number[] = [];
    for (const x of at(ex)) for (const y of at(ey)) { xs.push(x); ys.push(y); }
    const fcs = {
      version: "FCS3.1", nEvents: xs.length, instrument: "flow", keywords: {},
      channels: [
        { index: 0, name: "FSC-A", marker: null, bits: 64, range: 262144 },
        { index: 1, name: "B-A", marker: null, bits: 64, range: 262144 },
      ],
      columns: [Float64Array.from(xs), Float64Array.from(ys)],
      spillover: null,
    } as unknown as FcsFile;
    const sample = new Sample(fcs);
    expect(sample.rawPrecision("FSC-A")).toBe("float64");
    const held = maskOf(sample, tree);
    const n = held.reduce((a, v) => a + v, 0);
    expect(n).toBeGreaterThan(100);
    expect(n).toBeLessThan(held.length);
    const edgesX = new Set(Array.from(ex));
    const edgesY = new Set(Array.from(ey));
    for (const format of ["standard", "cytobank"] as const) {
      const xml = exportGatingML({ ...tree, sample, format, allowQuadrantOmission: true });
      const polygon = xml.match(/<gating:PolygonGate[\s\S]*?<\/gating:PolygonGate>/)![0];
      const values = [...polygon.matchAll(/data-type:value="([^"]+)"/g)].map((m) => Number(m[1]));
      const ring: Vertex[] = [];
      for (let i = 0; i + 1 < values.length; i += 2) ring.push([values[i], values[i + 1]]);
      // Every coordinate of the ring is a channel boundary of its float64 column, exactly.
      for (const [x, y] of ring) {
        expect(edgesX.has(x), `${format} x ${x}`).toBe(true);
        expect(edgesY.has(y), `${format} y ${y}`).toBe(true);
      }
      // The crossing test FlowKit's matches on an edge: a left or lower edge holds, a right or
      // upper one does not.
      const halfOpen = (x: number, y: number): number => {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [xi, yi] = ring[i];
          const [xj, yj] = ring[j];
          if ((yi > y) !== (yj > y) && x < xi + ((y - yi) * (xj - xi)) / (yj - yi)) inside = !inside;
        }
        return inside ? 1 : 0;
      };
      const read = xs.map((x, i) => halfOpen(x, ys[i]));
      expect(read.reduce((a, v, i) => a + (v !== held[i] ? 1 : 0), 0), format).toBe(0);
      // GateLab reading the ring without its mark takes a value within 1e-9 of an edge as on it
      // (flowjoGrid.ts, "One reader departs from this"), which adjacent doubles are; GateLab
      // restores the grid gate from its mark, and that reading is exact.
      const pnn: Record<string, string> = {};
      for (const c of sample.channels) pnn[c.pnn] = c.key;
      expect(differ(held, maskOf(sample, treeOf(importGatingML(xml, sample.channels.map((c) => c.key), pnn, "flow")))), format).toBe(0);
    }
  });

  // A float64 column can hold values far beyond the largest float32, which GateLab places on the
  // end channels. The ring's outer edges stopped just beyond the largest float32, so those values
  // lay outside it for every reader: tester version 6 probed corpus-flowjo-grid-double's rings at
  // ±1e155 and found 374 and 2 probes held by GateLab only.
  it("keeps a float64 column's values far beyond the largest float32 inside the ring on the end channels", () => {
    // Past the top of both axes, and from FSC-A 20000 up.
    const { tree } = importedTree([[20000, -1e7], [5e8, -1e7], [5e8, 5e8], [20000, 5e8]]);
    const xs = [1e155, 1e300, 150000.5, 150000.5, -1e155, 1e155];
    const ys = [1000.5, 1000.5, 1e155, 1e300, 1000.5, -1e155];
    const fcs = {
      version: "FCS3.1", nEvents: xs.length, instrument: "flow", keywords: {},
      channels: [
        { index: 0, name: "FSC-A", marker: null, bits: 64, range: 262144 },
        { index: 1, name: "B-A", marker: null, bits: 64, range: 262144 },
      ],
      columns: [Float64Array.from(xs), Float64Array.from(ys)],
      spillover: null,
    } as unknown as FcsFile;
    const sample = new Sample(fcs);
    expect(sample.rawPrecision("FSC-A")).toBe("float64");
    const held = maskOf(sample, tree);
    // Every event on the top channels is held; the one on FSC-A's first channel is not.
    expect(Array.from(held.slice(0, 5))).toEqual([1, 1, 1, 1, 0]);
    for (const format of ["standard", "cytobank"] as const) {
      const xml = exportGatingML({ ...tree, sample, format, allowQuadrantOmission: true });
      const polygon = xml.match(/<gating:PolygonGate[\s\S]*?<\/gating:PolygonGate>/)![0];
      const values = [...polygon.matchAll(/data-type:value="([^"]+)"/g)].map((m) => Number(m[1]));
      const ring: Vertex[] = [];
      for (let i = 0; i + 1 < values.length; i += 2) ring.push([values[i], values[i + 1]]);
      const halfOpen = (x: number, y: number): number => {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [xi, yi] = ring[i];
          const [xj, yj] = ring[j];
          if ((yi > y) !== (yj > y) && x < xi + ((y - yi) * (xj - xi)) / (yj - yi)) inside = !inside;
        }
        return inside ? 1 : 0;
      };
      expect(xs.map((x, i) => halfOpen(x, ys[i])), format).toEqual(Array.from(held));
      const pnn: Record<string, string> = {};
      for (const c of sample.channels) pnn[c.pnn] = c.key;
      expect(differ(held, maskOf(sample, treeOf(importGatingML(xml, sample.channels.map((c) => c.key), pnn, "flow")))), format).toBe(0);
    }
  });

  // The standard format's coordinates are Gating-ML scale values, the stored value / $PnG, and every
  // other gate is written divided by the gain; the grid ring was written in stored values. FlowKit
  // read the ring twice as wide on a channel with $PnG 2: FR-FCM-Z2KY Panel_M_pegi.wsp with the grid
  // on, "Single Cells-1" 39,901 events in GateLab and 9,670 in FlowKit, 8 of 9 populations differing;
  // FR-FCM-Z2JN Panel_B1.wsp all 8, Viable 166,039 against 664 (the release candidate's verifier).
  // GateLab's own reading restored the grid from its mark and said "not converted by $PnG".
  it("writes the ring in the standard format's scale values on a channel with a gain, and in stored values for Cytobank", () => {
    const { tree, sample: plain } = importedTree();
    const fcs = { ...plain.fcs, channels: plain.fcs.channels.map((c, i) => (i === 0 ? { ...c, gain: 2 } : c)) } as FcsFile;
    const sample = new Sample(fcs);
    const held = maskOf(sample, tree);
    const n = held.reduce((a, v) => a + v, 0);
    expect(n).toBeGreaterThan(100);
    const raw = [sample.rawColumnData(0), sample.rawColumnData(1)];
    const pnn: Record<string, string> = {};
    for (const c of sample.channels) pnn[c.pnn] = c.key;
    for (const format of ["standard", "cytobank"] as const) {
      const xml = exportGatingML({ ...tree, sample, format, allowQuadrantOmission: true });
      const polygon = xml.match(/<gating:PolygonGate[\s\S]*?<\/gating:PolygonGate>/)![0];
      const values = [...polygon.matchAll(/data-type:value="([^"]+)"/g)].map((m) => Number(m[1]));
      const ring: Vertex[] = [];
      for (let i = 0; i + 1 < values.length; i += 2) ring.push([values[i], values[i + 1]]);
      const halfOpen = (x: number, y: number): number => {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [xi, yi] = ring[i];
          const [xj, yj] = ring[j];
          if ((yi > y) !== (yj > y) && x < xi + ((y - yi) * (xj - xi)) / (yj - yi)) inside = !inside;
        }
        return inside ? 1 : 0;
      };
      // A reader of the standard format divides FSC-A by its gain; Cytobank's is read as stored.
      const g = format === "standard" ? 2 : 1;
      const read = Array.from(raw[0], (x, i) => halfOpen(x / g, raw[1][i]));
      expect(read.reduce((a, v, i) => a + (v !== held[i] ? 1 : 0), 0), format).toBe(0);
      // GateLab: from its mark, and from the ring alone, with the file's gains.
      // As the application imports a Gating-ML file: the file's gains, applied where the file is on scale values.
      const options = { ...gatingMLImportOptionsFor(sample), gains: gatingMlGains(sample) };
      const back = importGatingML(xml, sample.channels.map((c) => c.key), pnn, "flow", options);
      expect(isFlowJoGridGate(Object.values(back.gates)[0] as PolyRectGate), format).toBe(true);
      expect(back.gain?.unconverted ?? [], format).toEqual([]);
      expect(differ(held, maskOf(sample, treeOf(back))), format).toBe(0);
      const alone = importGatingML(xml.replace(/<gatelab_flowjo_grid>[\s\S]*?<\/gatelab_flowjo_grid>/, ""), sample.channels.map((c) => c.key), pnn, "flow", options);
      expect(differ(held, maskOf(sample, treeOf(alone))), format).toBe(0);
    }
  });

  it("reads the ring as written when another program has changed it, whatever the mark says", () => {
    const { tree, sample } = importedTree();
    const xml = exportGatingML({ ...tree, sample, format: "standard", allowQuadrantOmission: true });
    // Move one written coordinate: the mark no longer describes the ring.
    const edited = xml.replace(/(<gating:coordinate data-type:value=")([^"]+)(" \/>)/, (_, a, v, b) => `${a}${Number(v) * 0.5}${b}`);
    const res = importGatingML(edited, ["FSC-A", "B-A"], {}, "flow");
    const back = Object.values(res.gates)[0] as PolyRectGate;
    expect(isFlowJoGridGate(back)).toBe(false);
    expect(back.space).toBe("raw");
  });

  /** The ring alone, read by GateLab as another program would, with the mark stripped. */
  const ringAlone = (tree: Tree, sample: Sample, format: "standard" | "cytobank"): Tree => {
    const xml = exportGatingML({ ...tree, sample, format, allowQuadrantOmission: true })
      .replace(/<gatelab_flowjo_grid>[\s\S]*?<\/gatelab_flowjo_grid>/, "");
    const pnn: Record<string, string> = {};
    for (const c of sample.channels) pnn[c.pnn] = c.key;
    return treeOf(importGatingML(xml, sample.channels.map((c) => c.key), pnn, "flow"));
  };

  // Two of FlowJo's vertices on one channel pair make a zero-length edge in the gate GateLab
  // holds. The cells were enumerated with a polygon test that took such an edge to hold every
  // point, so the ring written went round the whole float32 plane, and every reader but GateLab
  // (which restores the grid gate from its mark) selected every event of the parent.
  it("writes a polygon with two vertices on one channel pair as its own cells, not the plane", () => {
    const vertices: Vertex[] = [RAW_VERTICES[0], [200000, 40], [200100, 41], RAW_VERTICES[2], RAW_VERTICES[3]];
    const { tree, gate, sample } = importedTree(vertices);
    expect(gate.vertices[1]).toEqual(gate.vertices[2]);
    const before = maskOf(sample, tree);
    const n = before.reduce((s, v) => s + v, 0);
    expect(n).toBeGreaterThan(100);
    expect(n).toBeLessThan(before.length * 0.9);
    for (const format of ["standard", "cytobank"] as const) {
      expect(differ(before, maskOf(sample, ringAlone(tree, sample, format)))).toBe(0);
    }
  });

  // Every vertex on one channel pair: the gate's boundary is that one lattice point, and a closed
  // test holds it, as the reference implementation of FlowJo's rule does. FlowJo's own count for
  // such a gate has not been measured (none is in the corpus's per-event data).
  it("selects the one cell of a polygon whose vertices all land on one channel pair, from the mark and the ring", () => {
    const vertices: Vertex[] = [[100000, 1000], [100100, 1001], [100200, 1002]];
    const { tree, gate } = importedTree(vertices);
    expect(gate.vertices[0]).toEqual(gate.vertices[1]);
    expect(gate.vertices[0]).toEqual(gate.vertices[2]);
    const sx = gate.transforms!["FSC-A"] as FlowJoGridSpec;
    const sy = gate.transforms!["B-A"] as FlowJoGridSpec;
    const ex = flowJoGridEdges(sx);
    const ey = flowJoGridEdges(sy);
    const [cx, cy] = gate.vertices[0];
    // Both corners of the cell and of its eight neighbours.
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = cx - 1; i <= cx + 1; i++) for (let j = cy - 1; j <= cy + 1; j++) {
      for (const a of [up32(ex[i]), down32(ex[i + 1])]) for (const b of [up32(ey[j]), down32(ey[j + 1])]) { xs.push(a); ys.push(b); }
    }
    const sample = new Sample({
      version: "FCS3.1", nEvents: xs.length, instrument: "flow", keywords: {},
      channels: [
        { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
        { index: 1, name: "B-A", marker: null, bits: 32, range: 262144 },
      ],
      columns: [Float32Array.from(xs), Float32Array.from(ys)],
      spillover: null,
    } as unknown as FcsFile);
    const before = maskOf(sample, tree);
    // The middle cell's four corner events, and no other.
    expect(Array.from(before).map((v, i) => (v ? i : -1)).filter((i) => i >= 0)).toEqual([16, 17, 18, 19]);
    for (const format of ["standard", "cytobank"] as const) {
      expect(differ(before, maskOf(sample, ringAlone(tree, sample, format)))).toBe(0);
    }
  });
});

describe("a FlowJo grid gate exported to a FlowJo workspace", () => {
  it("writes FlowJo's own raw vertices with its gateResolution, on the axes it was gridded on", () => {
    const { tree, sample } = importedTree();
    const { xml } = exportFlowJoWorkspace({ samples: [{ sample, fileName: "D1.fcs", ...tree }], now: new Date("2026-09-24T00:00:00Z"), producer: "GateLab test" });
    const polygon = xml.match(/<gating:PolygonGate[^>]*>[\s\S]*?<\/gating:PolygonGate>/)![0];
    expect(polygon).toContain('gateResolution="256"');
    expect(polygon).toContain('quadId="-1"');
    const values = [...polygon.matchAll(/data-type:value="([^"]+)"/g)].map((m) => Number(m[1]));
    expect(values).toEqual(RAW_VERTICES.flat());
    expect(xml).toMatch(/<transforms:linear transforms:minRange="0" transforms:maxRange="262144"[^>]*>\s*<data-type:parameter data-type:name="FSC-A"/);
    expect(xml).toMatch(/<transforms:biex transforms:length="256" transforms:maxRange="262144" transforms:neg="0" transforms:width="-10" transforms:pos="4.41854">\s*<data-type:parameter data-type:name="B-A"/);
  });

  it("writes an edited vertex at the middle of its channel, which FlowJo rounds back onto it", () => {
    const { tree, gate, sample } = importedTree();
    const edited: PolyRectGate = { ...gate, vertices: gate.vertices.map((v, i) => (i === 2 ? [v[0] - 7, v[1] + 3] : v) as Vertex) };
    const gates = { ...tree.gates, [gate.gate_id]: edited };
    const { xml } = exportFlowJoWorkspace({ samples: [{ sample, fileName: "D1.fcs", ...tree, gates }], now: new Date("2026-09-24T00:00:00Z"), producer: "GateLab test" });
    const values = [...xml.match(/<gating:PolygonGate[^>]*>[\s\S]*?<\/gating:PolygonGate>/)![0].matchAll(/data-type:value="([^"]+)"/g)].map((m) => Number(m[1]));
    const written: Vertex[] = [];
    for (let i = 0; i + 1 < values.length; i += 2) written.push([values[i], values[i + 1]]);
    // The untouched vertices are FlowJo's own; the edited one is its channel's centre.
    expect(written[0]).toEqual(RAW_VERTICES[0]);
    expect(written[2]).not.toEqual(RAW_VERTICES[2]);
    const gx = flowJoGridScale(edited.transforms!["FSC-A"] as FlowJoGridSpec);
    const gy = flowJoGridScale(edited.transforms!["B-A"] as FlowJoGridSpec);
    expect([gx.vertexCell(written[2][0]), gy.vertexCell(written[2][1])]).toEqual(edited.vertices[2]);
    // And the FlowJo importer, on FlowJo's rule, reads back exactly the edited gate.
    const conv = flowJoWorkspaceToGatingML(xml, 0, null, undefined, { flowJoGrid: true });
    const res = importGatingML(conv.gatingMl, ["FSC-A", "B-A"], {}, "flow");
    const back = Object.values(res.gates)[0] as PolyRectGate;
    expect(back.vertices).toEqual(edited.vertices);
    expect(differ(maskOf(sample, { ...tree, gates }), maskOf(sample, treeOf(res)))).toBe(0);
  });

  // The file holds FlowJo's numbers as FlowJo saved them. At the 15 significant digits the
  // exporter writes elsewhere, a vertex within about 5e-15 of a channel boundary crossed it
  // (98815.99999999999 was written 98816, channel 97 instead of 96 on a 0 to 262144 axis), and an
  // axis parameter written short would move the whole grid.
  it("writes FlowJo's vertices and the grid's axis parameters exactly, so no vertex changes channel", () => {
    const vertices: Vertex[] = [[98815.99999999999, 1000], ...RAW_VERTICES.slice(1)];
    const { tree, gate, sample } = importedTree(vertices, (w) => w.replace('transforms:pos="4.41854"', 'transforms:pos="4.418539922106808"'));
    const gx = flowJoGridScale(gate.transforms!["FSC-A"] as FlowJoGridSpec);
    expect(gx.vertexCell(98815.99999999999)).toBe(96);
    expect(gx.vertexCell(98816)).toBe(97);
    const { xml } = exportFlowJoWorkspace({ samples: [{ sample, fileName: "D1.fcs", ...tree }], now: new Date("2026-09-24T00:00:00Z"), producer: "GateLab test" });
    const polygon = xml.match(/<gating:PolygonGate[^>]*>[\s\S]*?<\/gating:PolygonGate>/)![0];
    expect([...polygon.matchAll(/data-type:value="([^"]+)"/g)].map((m) => Number(m[1]))).toEqual(vertices.flat());
    expect(xml).toContain('transforms:pos="4.418539922106808"');
    const conv = flowJoWorkspaceToGatingML(xml, 0, null, undefined, { flowJoGrid: true });
    const back = Object.values(importGatingML(conv.gatingMl, ["FSC-A", "B-A"], {}, "flow").gates)[0] as PolyRectGate;
    expect(back.vertices).toEqual(gate.vertices);
    expect(back.transforms).toEqual(gate.transforms);
  });
});

describe("a FlowJo grid gate kept", () => {
  function workspaceWith(tree: Tree): WorkspaceFile {
    return {
      format: "gatelab-workspace", version: 2, savedAt: "2026-09-24T00:00:00.000Z", app: "GateLab",
      samples: [{ fileName: "D1.fcs", dataPath: "data/0_D1.fcs", logicleW: {}, cytofCofactor: 5, compensationOn: false }],
      activeSample: 0,
      gating: {
        gates: tree.gates, gate_order: tree.gate_order, populations: tree.populations,
        root_population_id: tree.root_population_id, active_population_id: tree.root_population_id, selected_gate_id: null,
      },
      scales: { globalScales: {} },
      display: { xChannel: "FSC-A", yChannel: "B-A", mode: "dots", maxEvents: 1000, contourThreshold: 5 },
    } as unknown as WorkspaceFile;
  }

  it("in a saved workspace: the grid, its vertices and FlowJo's raw vertices, and the same events", () => {
    const { tree, gate, sample } = importedTree();
    const back = readWorkspaceBytes(packWorkspaceReference(workspaceWith(tree))).ws;
    const kept = back.gating.gates[gate.gate_id] as PolyRectGate;
    expect(kept).toEqual(gate);
    expect(differ(maskOf(sample, tree), maskOf(sample, { ...tree, gates: back.gating.gates }))).toBe(0);
  });

  it("keeps a rule-imported rectangle's FlowJo axes and the bounds FlowJo saved, and refuses malformed bounds", () => {
    const { tree } = importedTree();
    const rect: PolyRectGate = {
      gate_id: "box", name: "Box", gate_type: "rectangle", x_channel: "B-A", y_channel: "FSC-A",
      vertices: [[-1e9, 0], [1000, 0], [1000, 50000], [-1e9, 50000]], color: "#000000", label_offset: null,
      flowjo_axes: { "B-A": { kind: "biex", maxValue: 262144, pos: 4.41854, neg: 0, widthBasis: -10, channelRange: 256 } },
      flowjo_bounds: { "B-A": [-250.5, null] },
    };
    const withBox = (box: unknown) => workspaceWith({ ...tree, gates: { ...tree.gates, box: box as Gate }, gate_order: [...tree.gate_order, "box"] });
    const back = readWorkspaceBytes(packWorkspaceReference(withBox(rect))).ws.gating.gates.box as PolyRectGate;
    expect(back.flowjo_axes).toEqual(rect.flowjo_axes);
    expect(back.flowjo_bounds).toEqual({ "B-A": [-250.5, null] });
    const bad = { ...rect, flowjo_bounds: { "B-A": [-250.5, "open"] } };
    expect(() => readWorkspaceBytes(new TextEncoder().encode(JSON.stringify(withBox(bad))))).toThrow(/invalid FlowJo bounds/);
  });

  it("keeps a continuous FlowJo polygon's own quadId and gateResolution, and refuses malformed ones", () => {
    const { tree } = importedTree();
    const panel: PolyRectGate = {
      gate_id: "panel", name: "Panel", gate_type: "polygon", x_channel: "FSC-A", y_channel: "B-A",
      vertices: [[10, 20], [200, 20], [100, 250]], color: "#000000", label_offset: null,
      flowjo_polygon: { quadId: 2, gateResolution: null },
    };
    const withPanel = (g: unknown) => workspaceWith({ ...tree, gates: { ...tree.gates, panel: g as Gate }, gate_order: [...tree.gate_order, "panel"] });
    const back = readWorkspaceBytes(packWorkspaceReference(withPanel(panel))).ws.gating.gates.panel as PolyRectGate;
    expect(back.flowjo_polygon).toEqual({ quadId: 2, gateResolution: null });
    const bad = { ...panel, flowjo_polygon: { quadId: "2", gateResolution: null } };
    expect(() => readWorkspaceBytes(new TextEncoder().encode(JSON.stringify(withPanel(bad))))).toThrow(/invalid FlowJo polygon attributes/);
  });

  it("refuses a saved workspace whose grid cannot be built, rather than reading it as something else", () => {
    const { tree, gate } = importedTree();
    const broken = { ...gate, transforms: { ...gate.transforms!, "B-A": { kind: "flowjoChannels", channels: 256, axis: { kind: "biex", maxValue: 262144 } } as unknown as TransformSpec } };
    const ws = workspaceWith({ ...tree, gates: { ...tree.gates, [gate.gate_id]: broken } });
    expect(() => readWorkspaceBytes(new TextEncoder().encode(JSON.stringify(ws)))).toThrow(/invalid flowjoChannels transform/);
  });

  it("keeps a biex gate saved before FlowJo's table on the table it was saved on", () => {
    const saved = { kind: "biex" as const, maxValue: 262144, pos: 4.41854, neg: 0, widthBasis: -10, channelRange: 256 };
    const now = { ...saved, tableChannels: 4096 };
    // The same stored coordinate is a different raw value on the two tables.
    expect(biexTransform(saved).inverse(40)).not.toBeCloseTo(biexTransform(now).inverse(40), 3);
    const gate: PolyRectGate = {
      gate_id: "old", name: "Saved_before", gate_type: "polygon", x_channel: "B-A", y_channel: "FSC-A",
      vertices: [[30, 1000], [200, 1000], [120, 90000]], space: "display",
      transforms: { "B-A": saved, "FSC-A": { kind: "identity" } }, color: "#000000", label_offset: null,
    };
    const { tree } = importedTree();
    const ws = workspaceWith({ ...tree, gates: { ...tree.gates, old: gate }, gate_order: [...tree.gate_order, "old"] });
    const back = readWorkspaceBytes(packWorkspaceReference(ws)).ws.gating.gates.old as PolyRectGate;
    expect(back.transforms!["B-A"]).toEqual(saved);
    expect("tableChannels" in back.transforms!["B-A"]).toBe(false);
  });
});

describe("a FlowJo grid gate edited and shown", () => {
  it("keeps edited vertices on channels, beyond the axis too, where an event would be clamped", () => {
    const { gate, sample } = importedTree();
    // A vertex dragged to a raw value past the top of the linear axis: channel 300, not 255.
    const raw = 300 * 1024 + 100;
    expect(sample.rawToGate(gate, "FSC-A", raw)).toBe(300);
    expect(sample.gateToRaw(gate, "FSC-A", 300)).toBe(300 * 1024);
    // Through the display, as a drag arrives: still an integer channel.
    const display = sample.rawToDisplay("FSC-A", 123456);
    expect(Number.isInteger(sample.displayToGate(gate, "FSC-A", display))).toBe(true);
    expect(sample.displayToGate(gate, "FSC-A", display)).toBe(Math.floor(123456 / 1024 + 0.5));
  });

  it("names the grid on its badge", () => {
    const { gate, sample } = importedTree();
    const badge = gateSpaceBadge(sample, gate)!;
    expect(badge.text.slice(0, 2)).toBe("FF");
    expect(badge.hint).toMatch(/FlowJo's grid/);
    expect(badge.hint).toMatch(/FlowJo's 256-channel grid, linear 0\.000 to 2\.621e\+5/);
    expect(badge.hint).toMatch(/biex .* on FlowJo's 4096-channel table/);
  });
});

describe("what a user reads about a gate's axes", () => {
  it("says which biex table a continuous gate is evaluated on", () => {
    const { sample } = importedTree();
    const onFlowJo: PolyRectGate = {
      gate_id: "a", name: "On_FlowJo_table", gate_type: "polygon", x_channel: "B-A", y_channel: "FSC-A",
      vertices: [[30, 1000], [200, 1000], [120, 90000]], space: "display",
      transforms: { "B-A": { kind: "biex", maxValue: 262144, pos: 4.41854, neg: 0, widthBasis: -10, channelRange: 256, tableChannels: 4096 }, "FSC-A": { kind: "identity" } },
      color: "#000000", label_offset: null,
    };
    const legacy: PolyRectGate = { ...onFlowJo, gate_id: "b", transforms: { "B-A": { kind: "biex", maxValue: 262144, pos: 4.41854, neg: 0, widthBasis: -10, channelRange: 256 }, "FSC-A": { kind: "identity" } } };
    expect(gateSpaceBadge(sample, onFlowJo)!.hint).toMatch(/FlowJo biex \(width -10\.00, neg 0, pos 4\.41854\), on FlowJo's 4096-channel table/);
    expect(gateSpaceBadge(sample, legacy)!.hint).toMatch(/on the 256-channel table GateLab used before 2026-09-24/);
  });

  it("names FlowJo's grid in the hierarchy CSV's note, not the code's word for it", () => {
    const { tree } = importedTree();
    const out = exportHierarchyCsv(Object.values(tree.gates), tree.populations, tree.root_population_id);
    expect(out.notes.join("\n")).toContain("CD4_positive: a polygon on FlowJo's 256-channel grid, which the file cannot name.");
    expect(out.notes.join("\n")).not.toContain("flowjoChannels");
  });
});
