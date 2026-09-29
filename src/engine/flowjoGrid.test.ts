// @vitest-environment jsdom
//
// FlowJo's gate grid (flowjoGrid.ts). The first block is the one that matters: representative
// polygons of the three datasets FlowJo's rule was established on, imported through the whole
// FlowJo path, against expected per-event membership on synthetic events placed on both corners
// of every grid cell near each outline and beyond both ends of each axis. The expected membership
// comes from an independent implementation of the rule that reproduced FlowJo's own exported
// memberships event for event (see the fixture's "about"). Synthetic file, gate and channel names.

import { describe, expect, it } from "vitest";
import oracle from "./__fixtures__/flowjo_grid_oracle.json";
import { flowJoWorkspaceToGatingML } from "./flowjoWorkspace";
import { importGatingML } from "./gatingml";
import { Sample } from "./sample";
import { applyGatingStrategy } from "./populations";
import { gateMaskPolygon, pointInPolygon } from "./gates";
import type { FcsFile } from "./fcs";
import type { FlowJoGridAxis, Vertex } from "./models";
import { generateBiexLut } from "./biex";
import {
  FLOAT32_MAX, flowJoGridCells, flowJoGridEdges, flowJoGridRing, flowJoGridScale, parseFlowJoGridSpec,
  type FlowJoGridSpec,
} from "./flowjoGrid";

const G = "http://www.isac-net.org/std/Gating-ML/v2.0/gating";
const D = "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes";
const T = "http://www.isac-net.org/std/Gating-ML/v2.0/transformations";

type FixtureAxis =
  | { kind: "linear"; minRange: number; maxRange: number }
  | { kind: "log"; offset: number; decades: number }
  | { kind: "biex"; maxRange: number; pos: number; neg: number; width: number; length: number };
interface FixtureGate {
  label: string; x: FixtureAxis; y: FixtureAxis; vertices: Vertex[]; vertexChannels: Vertex[];
  n: number; inside: number; events: string; membership: string;
}
const fixture = oracle as unknown as { gates: FixtureGate[] };

function transformXml(axis: FixtureAxis, param: string): string {
  const p = `<data-type:parameter data-type:name="${param}"/>`;
  if (axis.kind === "linear") {
    return `<transforms:linear transforms:minRange="${axis.minRange}" transforms:maxRange="${axis.maxRange}" transforms:gain="1">${p}</transforms:linear>`;
  }
  if (axis.kind === "log") {
    return `<transforms:log transforms:offset="${axis.offset}" transforms:decades="${axis.decades}">${p}</transforms:log>`;
  }
  return `<transforms:biex transforms:length="${axis.length}" transforms:maxRange="${axis.maxRange}" transforms:neg="${axis.neg}" transforms:width="${axis.width}" transforms:pos="${axis.pos}">${p}</transforms:biex>`;
}

/** A one-polygon workspace in FlowJo's shape, on channels X and Y. */
function workspaceOf(x: FixtureAxis, y: FixtureAxis, vertices: Vertex[], extra = "", flowJoVersion?: string): string {
  const v = vertices.map(([a, b]) => `<gating:vertex><gating:coordinate data-type:value="${a}"/><gating:coordinate data-type:value="${b}"/></gating:vertex>`).join("");
  const version = flowJoVersion ? ` flowJoVersion="${flowJoVersion}"` : "";
  return `<Workspace xmlns:transforms="${T}" xmlns:data-type="${D}" xmlns:gating="${G}"${version}><SampleList><Sample>
    <DataSet uri="file:D1.fcs"/>
    <Transformations>${transformXml(x, "X")}${transformXml(y, "Y")}</Transformations>
    <SampleNode name="D1.fcs" count="1"><Subpopulations>
      <Population name="Grid_gate" count="1"><Gate>
        <gating:PolygonGate eventsInside="1" quadId="-1" gateResolution="256" gating:id="g1"${extra}>
          <gating:dimension><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
          <gating:dimension><data-type:fcs-dimension data-type:name="Y"/></gating:dimension>
          ${v}
        </gating:PolygonGate></Gate></Population>
    </Subpopulations></SampleNode></Sample></SampleList></Workspace>`;
}

function fcsOf(xs: Float32Array, ys: Float32Array): FcsFile {
  return {
    version: "FCS3.1", nEvents: xs.length, instrument: "flow", keywords: {},
    channels: [
      { index: 0, name: "X", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "Y", marker: null, bits: 32, range: 262144 },
    ],
    columns: [xs, ys],
    spillover: null,
  } as unknown as FcsFile;
}

/** The one population's membership, imported as the application imports a FlowJo workspace. */
function importAndGate(xml: string, xs: Float32Array, ys: Float32Array, grid: boolean): { mask: Uint8Array; gridPolygons: number } {
  const conv = flowJoWorkspaceToGatingML(xml, 0, null, undefined, { flowJoGrid: grid });
  const sample = new Sample(fcsOf(xs, ys));
  const pnn: Record<string, string> = {};
  for (const c of sample.channels) pnn[c.pnn] = c.key;
  const res = importGatingML(conv.gatingMl, sample.channels.map((c) => c.key), pnn, sample.instrument);
  const { masks } = applyGatingStrategy(res.gates, res.populations, res.root_population_id, sample.gateAssayData());
  const pid = Object.keys(res.populations).find((id) => id !== res.root_population_id)!;
  return { mask: masks[pid], gridPolygons: conv.gridPolygons };
}

function decodeEvents(b64: string): { xs: Float32Array; ys: Float32Array } {
  const bytes = Uint8Array.from(Buffer.from(b64, "base64"));
  const all = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const n = all.length / 2;
  const xs = new Float32Array(n);
  const ys = new Float32Array(n);
  for (let i = 0; i < n; i++) { xs[i] = all[2 * i]; ys[i] = all[2 * i + 1]; }
  return { xs, ys };
}
function decodeBits(b64: string, n: number): Uint8Array {
  const bytes = Buffer.from(b64, "base64");
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (bytes[i >> 3] >> (i & 7)) & 1;
  return out;
}

describe("FlowJo's gate grid, per event, on representative gates of the three reference datasets", () => {
  expect(fixture.gates).toHaveLength(8);
  for (const g of fixture.gates) {
    it(`reproduces the expected membership of every event: ${g.label}`, () => {
      const { xs, ys } = decodeEvents(g.events);
      expect(xs.length).toBe(g.n);
      const want = decodeBits(g.membership, g.n);
      const { mask, gridPolygons } = importAndGate(workspaceOf(g.x, g.y, g.vertices), xs, ys, true);
      expect(gridPolygons).toBe(1);
      let wrong = 0;
      for (let i = 0; i < g.n; i++) if (mask[i] !== want[i]) wrong++;
      expect(wrong, `${wrong} of ${g.n} events differ`).toBe(0);
      expect(mask.reduce((s, v) => s + v, 0)).toBe(g.inside);
    });
  }

  it("puts the vertices on the channels the reference puts them on, beyond the axis too", () => {
    for (const g of fixture.gates) {
      const conv = flowJoWorkspaceToGatingML(workspaceOf(g.x, g.y, g.vertices), 0);
      const res = importGatingML(conv.gatingMl, ["X", "Y"], {}, "flow");
      const gate = Object.values(res.gates)[0];
      expect(gate.gate_type === "polygon" ? gate.vertices : null, g.label).toEqual(g.vertexChannels);
    }
    // The fixture reaches below a linear axis, where a vertex is not clamped, and past both ends
    // of a biex table, where a vertex is on the table's end as an event would be.
    const channels = fixture.gates.flatMap((g) => g.vertexChannels.flat());
    expect(Math.min(...channels)).toBe(-3);
    const below = fixture.gates.find((g) => g.label.includes("below the biex table"))!;
    const above = fixture.gates.find((g) => g.label.includes("above the biex table"))!;
    const table = (a: FixtureAxis) => (a.kind === "biex"
      ? generateBiexLut({ maxValue: a.maxRange, pos: a.pos, neg: a.neg, widthBasis: a.width, channelRange: a.length, tableChannels: 4096 }).x
      : null);
    const bx = table(below.x)!;
    const ax = table(above.x)!;
    expect(below.vertices.some(([v], i) => v < bx[0] && below.vertexChannels[i][0] === 0)).toBe(true);
    expect(above.vertices.some(([v], i) => v > ax[4096] && above.vertexChannels[i][0] === 256)).toBe(true);
  });

  // Off, the same gates are evaluated continuously on their drawn lines, and the events near their
  // edges fall differently: the fixture is built there, so this is where the two modes part.
  it("evaluates the same gates continuously when the option is off, and they differ at the edges", () => {
    let differ = 0;
    for (const g of fixture.gates) {
      const { xs, ys } = decodeEvents(g.events);
      const want = decodeBits(g.membership, g.n);
      const { mask, gridPolygons } = importAndGate(workspaceOf(g.x, g.y, g.vertices), xs, ys, false);
      expect(gridPolygons).toBe(0);
      for (let i = 0; i < g.n; i++) if (mask[i] !== want[i]) differ++;
    }
    expect(differ).toBeGreaterThan(100);
  });
});

// ── The rule, axis by axis ──────────────────────────────────────────────────────────────────

const grid = (axis: FlowJoGridAxis, channels = 256): FlowJoGridSpec => ({ kind: "flowjoChannels", channels, axis });
const linear = (minRange: number, maxRange: number) => flowJoGridScale(grid({ kind: "linear", minRange, maxRange }));
/** The float32 next to a float32 value, in the direction given. */
function step32(f: number, dir: 1 | -1): number {
  const a = new Float32Array([f]);
  const u = new Uint32Array(a.buffer);
  if (a[0] === 0) { u[0] = dir > 0 ? 1 : 0x80000001; return a[0]; }
  if ((a[0] > 0) === (dir > 0)) u[0] += 1; else u[0] -= 1;
  return a[0];
}
/** The smallest float32 above a number, and the largest below it. */
const up32 = (v: number): number => { const f = Math.fround(v); return f > v ? f : step32(f, 1); };
const down32 = (v: number): number => { const f = Math.fround(v); return f < v ? f : step32(f, -1); };

describe("FlowJo's grid on a linear axis", () => {
  it("rounds half up to the nearest of 256 channels over the saved range", () => {
    const s = linear(0, 262144); // 1024 per channel
    expect(s.eventCell(0)).toBe(0);
    expect(s.eventCell(511.99)).toBe(0);
    expect(s.eventCell(512)).toBe(1); // exactly half a channel rounds up
    expect(s.eventCell(1024)).toBe(1);
    expect(s.eventCell(1535.99)).toBe(1);
    expect(s.eventCell(1536)).toBe(2);
  });

  it("clamps events to 0 and 255 at both ends, and leaves vertices where they fall", () => {
    const s = linear(0, 262144);
    expect(s.eventCell(-5e6)).toBe(0);
    expect(s.eventCell(262144 * 5)).toBe(255);
    expect(s.eventCell(261632)).toBe(255); // 255.5 rounds to 256, clamped
    expect(s.vertexCell(-3000)).toBe(-3);
    expect(s.vertexCell(262144 * 1.02)).toBe(261);
  });

  it("uses the axis as the sample saved it: zoomed in, zoomed out, and offset from zero", () => {
    // Zoomed in to [0, 131072]: 512 per channel.
    expect(linear(0, 131072).eventCell(768)).toBe(2);
    // Zoomed out beyond $PnR, to [0, 1048576]: 4096 per channel.
    expect(linear(0, 1048576).eventCell(6144)).toBe(2);
    // Offset: [-66667, 262144], a range of 328811.
    const off = linear(-66667, 262144);
    expect(off.eventCell(-66667)).toBe(0);
    expect(off.channel(-66667 + 328811 / 2)).toBeCloseTo(128, 10);
    expect(off.eventCell(-66667 + 328811 / 2)).toBe(128);
  });

  it("takes a channel back to the middle of its events, which rounds onto it again", () => {
    const s = linear(-66667, 262144);
    for (const c of [-7, 0, 1, 100, 255, 300]) expect(s.vertexCell(s.centre(c))).toBe(c);
  });
});

describe("FlowJo's grid on a log axis", () => {
  const s = flowJoGridScale(grid({ kind: "wsplog", offset: 100, decades: 4 })); // 64 channels a decade
  it("rounds log10(v / offset) / decades · 256 half up", () => {
    expect(s.eventCell(100)).toBe(0);
    expect(s.eventCell(1000)).toBe(64);
    expect(s.eventCell(100 * Math.pow(10, 64.49 / 64))).toBe(64);
    expect(s.eventCell(100 * Math.pow(10, 64.51 / 64))).toBe(65);
    expect(s.eventCell(1e6)).toBe(255);
  });
  it("puts zero, negative and sub-offset events on channel 0", () => {
    for (const v of [0, -5, 1, 99.9]) expect(s.eventCell(v)).toBe(0);
  });
  it("leaves a vertex below the offset below the axis", () => {
    expect(s.vertexCell(10)).toBe(-64);
    expect(s.vertexCell(s.centre(-64))).toBe(-64);
  });
  // A vertex at or below zero has no logarithm; the scale takes it at 1e-300, about channel -19,000
  // here, far below the axis.
  it("takes a vertex at or below zero far below the axis", () => {
    for (const v of [0, -93.44]) expect(s.vertexCell(v), `${v}`).toBeLessThan(-19000);
  });
  // Which FlowJo does depends on its version. FlowJo 10.6 counts a polygon with such a vertex as if
  // the vertex were on the axis floor, channel 0: FR-FCM-Z2KY's CD3+ (10.6.2, a vertex at -93.44)
  // held 67,180 events far below against FlowJo's 69,124, and 69,124 on the floor; FR-FCM-Z2V7
  // (10.6.1) 5 of 13 populations exact far below, 11 on the floor. FlowJo 10.2 and earlier take it
  // far below: FR-FCM-ZZSX (10.0.7r2) 15 of 16 exact far below, 3 on the floor; FR-FCM-ZY9F (10.2)
  // 320 events off far below, 1,679 on the floor.
  const logAxis = { kind: "log" as const, offset: 1, decades: 4.5 };
  const n = 160;
  const xs = new Float32Array(n * n);
  const ys = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      xs[i * n + j] = Math.pow(10, (4.5 * i) / n);
      ys[i * n + j] = Math.pow(10, (4.5 * j) / n);
    }
  }
  const drawn: Vertex[] = [[-93.44, 100], [5000, 3000], [5000, 20000], [10, 20000]];
  const onFloor: Vertex[] = [[1, 100], [5000, 3000], [5000, 20000], [10, 20000]];
  const farBelow: Vertex[] = [[1e-300, 100], [5000, 3000], [5000, 20000], [10, 20000]];
  const moved = (a: Uint8Array, b: Uint8Array) => a.reduce((d, v, i) => d + (v !== b[i] ? 1 : 0), 0);
  for (const [version, like, label] of [
    ["10.6.2", onFloor, "on the floor"], ["10.10.0", onFloor, "on the floor"],
    ["10.2", farBelow, "far below"], ["10.0.7r2", farBelow, "far below"], [undefined, farBelow, "far below"],
  ] as [string | undefined, Vertex[], string][]) {
    it(`FlowJo ${version ?? "of no stated version"}: holds a polygon with a vertex below zero as with the vertex ${label}`, () => {
      const below = importAndGate(workspaceOf(logAxis, logAxis, drawn, "", version), xs, ys, true).mask;
      const expected = importAndGate(workspaceOf(logAxis, logAxis, like, "", version), xs, ys, true).mask;
      const other = importAndGate(workspaceOf(logAxis, logAxis, like === onFloor ? farBelow : onFloor, "", version), xs, ys, true).mask;
      expect(expected.reduce((a, v) => a + v, 0)).toBeGreaterThan(1000);
      expect(moved(expected, other)).toBeGreaterThan(100);
      expect(moved(below, expected)).toBe(0);
    });
  }
});

describe("FlowJo's grid on a biex axis", () => {
  const axis = { kind: "biex" as const, maxValue: 262144, pos: 4.418540, neg: 0, widthBasis: -10, channelRange: 256 };
  const s = flowJoGridScale(grid(axis));
  const { x } = generateBiexLut({ ...axis, tableChannels: 4096 });

  it("floors the 4096-channel table's index to sixteenths: channel = floor(index / 16)", () => {
    expect(x.length).toBe(4097);
    for (const j of [0, 15, 16, 17, 1000, 2047, 2048, 4080, 4095]) {
      expect(s.eventCell(x[j]), `entry ${j}`).toBe(Math.floor(j / 16));
      // Just below an entry is the entry before, whatever interpolation would say.
      if (j > 0) expect(s.eventCell(down32(x[j])), `below entry ${j}`).toBe(Math.floor((j - 1) / 16));
    }
  });

  it("puts events below the table on channel 0, and at or above its top on channel 256, the last entry's", () => {
    expect(s.cells).toBe(257);
    expect(s.eventCell(x[0] - 1e6)).toBe(0);
    expect(s.eventCell(-Infinity)).toBe(0);
    expect(s.eventCell(x[4096] * 10)).toBe(256);
    expect(s.eventCell(x[4096])).toBe(256); // index 4096: a channel of its own
    expect(s.eventCell(down32(x[4096]))).toBe(255);
  });

  it("puts a vertex beyond the table on the table's end, as it does an event", () => {
    const bottom = x[1] - x[0];
    const top = x[4096] - x[4095];
    // 76 channels (1216 table entries) below the table, and 42 above it: FlowRepository's counts
    // decide this, where the reference data do not (flowjoGrid.ts).
    expect(s.vertexCell(x[0] - 1216 * bottom)).toBe(0);
    expect(s.vertexCell(x[0] - 1e9)).toBe(0);
    expect(s.vertexCell(x[4096] + 42 * 16 * top)).toBe(256);
    expect(s.vertexCell(x[4096] * 1e6)).toBe(256);
    // And a channel's centre rounds back onto it, the table's last entry for channel 256.
    for (let c = 0; c <= 256; c++) expect(s.vertexCell(s.centre(c))).toBe(c);
    expect(s.centre(256)).toBe(x[4096]);
  });

  it("is built on FlowJo's table whatever table a saved continuous spec used", () => {
    const legacy = generateBiexLut(axis);
    expect(legacy.x.length).toBe(257);
    // Cytolib's 256-channel table puts channel 111's lower edge elsewhere: one reason the grid
    // failed on it. The grid's edge is FlowJo's entry 1776.
    expect(s.eventCell(x[1776])).toBe(111);
    expect(x[1776]).not.toBeCloseTo(legacy.x[111], 3);
  });
});

describe("a mixed grid", () => {
  it("takes each axis by its own rule and tests the polygon on the one integer grid, edges included", () => {
    const bx = flowJoGridScale(grid({ kind: "biex", maxValue: 262144, pos: 4.418540, neg: 0, widthBasis: -10, channelRange: 256 }));
    const ly = linear(0, 262144);
    const square: Vertex[] = [[100, 50], [140, 50], [140, 90], [100, 90]];
    const inside = (vx: number, vy: number) => pointInPolygon(bx.eventCell(vx), ly.eventCell(vy), square.map((v) => v[0]), square.map((v) => v[1]));
    expect(inside(bx.centre(100), ly.centre(50))).toBe(true); // a corner cell
    expect(inside(bx.centre(99), ly.centre(70))).toBe(false);
    expect(inside(bx.centre(140), ly.centre(90))).toBe(true); // the far corner, closed
    expect(inside(bx.centre(141), ly.centre(90))).toBe(false);
  });
});

describe("grid specs read from a file", () => {
  it("accepts each axis kind and refuses anything it cannot build", () => {
    expect(parseFlowJoGridSpec(grid({ kind: "linear", minRange: 0, maxRange: 1 }))).not.toBeNull();
    expect(parseFlowJoGridSpec(grid({ kind: "wsplog", offset: 1, decades: 4 }))).not.toBeNull();
    expect(parseFlowJoGridSpec(grid({ kind: "biex", maxValue: 262144, pos: 4.5, neg: 0, widthBasis: -10, channelRange: 256 }))).not.toBeNull();
    expect(parseFlowJoGridSpec(grid({ kind: "linear", minRange: 5, maxRange: 5 }))).toBeNull();
    expect(parseFlowJoGridSpec({ kind: "flowjoChannels", channels: 256.5, axis: { kind: "linear", minRange: 0, maxRange: 1 } })).toBeNull();
    expect(parseFlowJoGridSpec({ kind: "flowjoChannels", channels: 256, axis: { kind: "logicle" } })).toBeNull();
    expect(parseFlowJoGridSpec({ kind: "flowjoChannels", channels: 256, axis: { kind: "biex", maxValue: 262144, pos: 4.5, neg: 0, widthBasis: -10, channelRange: 0 } })).toBeNull();
  });
});

// ── The union of cells a grid polygon is exported as ─────────────────────────────────────────

describe("a grid polygon as the union of its cells, in raw units", () => {
  const specs: FlowJoGridSpec[] = [
    grid({ kind: "linear", minRange: -66667, maxRange: 262144 }),
    grid({ kind: "wsplog", offset: 31.6, decades: 4.5 }),
    grid({ kind: "biex", maxValue: 262144, pos: 4.418540, neg: 0, widthBasis: -10, channelRange: 256 }),
  ];

  it("places every edge between the last float32 of one channel and the first of the next", () => {
    for (const spec of specs) {
      const s = flowJoGridScale(spec);
      const e = flowJoGridEdges(spec);
      expect(e.length).toBe(s.cells + 1);
      for (let c = 1; c < s.cells; c++) {
        // The float32 just above the edge is on channel c; the one just below on c − 1.
        expect(s.eventCell(up32(e[c])), `${spec.axis.kind} edge ${c} above`).toBe(c);
        expect(s.eventCell(down32(e[c])), `${spec.axis.kind} edge ${c} below`).toBe(c - 1);
      }
      // The outer edges lie beyond the largest float32, which an event can hold, and a reader
      // parsing float32 reads them as the largest float32 (flowjoGrid.ts, RING_OUTER).
      expect(e[0]).toBeLessThan(-FLOAT32_MAX);
      expect(e[s.cells]).toBeGreaterThan(FLOAT32_MAX);
      expect(Math.fround(e[0])).toBe(-FLOAT32_MAX);
      expect(Math.fround(e[s.cells])).toBe(FLOAT32_MAX);
    }
  });

  /** Events of every kind that decide a cell: both corners of each cell, and far beyond. */
  function eventsFor(sx: FlowJoGridSpec, sy: FlowJoGridSpec): { xs: Float32Array; ys: Float32Array } {
    const ex = flowJoGridEdges(sx);
    const ey = flowJoGridEdges(sy);
    const nx = flowJoGridScale(sx).cells;
    const ny = flowJoGridScale(sy).cells;
    // The lowest and highest float32 of each channel; the end channels reach far beyond the axis.
    const xsOf = (c: number): number[] => [c === 0 ? -1e30 : up32(ex[c]), c === nx - 1 ? 1e30 : down32(ex[c + 1])];
    const ysOf = (c: number): number[] => [c === 0 ? -1e30 : up32(ey[c]), c === ny - 1 ? 1e30 : down32(ey[c + 1])];
    const xs: number[] = [];
    const ys: number[] = [];
    const every = (n: number): number[] => [...Array.from({ length: Math.ceil(n / 3) }, (_, k) => 3 * k), n - 1];
    for (const cx of every(nx)) for (const cy of every(ny)) {
      for (const a of xsOf(cx)) for (const b of ysOf(cy)) { xs.push(a); ys.push(b); }
    }
    return { xs: Float32Array.from(xs), ys: Float32Array.from(ys) };
  }

  function gridMask(sx: FlowJoGridSpec, sy: FlowJoGridSpec, verts: Vertex[], xs: Float32Array, ys: Float32Array): Uint8Array {
    const gx = flowJoGridScale(sx);
    const gy = flowJoGridScale(sy);
    const cx = Float32Array.from(xs, (v) => gx.eventCell(v));
    const cy = Float32Array.from(ys, (v) => gy.eventCell(v));
    return gateMaskPolygon(cx, cy, verts);
  }

  /** FlowKit's polygon test keeps an event on a left or lower edge and drops one on a right or upper one. */
  function halfOpenMask(xs: Float32Array, ys: Float32Array, ring: Vertex[]): Uint8Array {
    const out = new Uint8Array(xs.length);
    for (let i = 0; i < xs.length; i++) {
      let inside = false;
      for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
        const [xi, yi] = ring[a];
        const [xj, yj] = ring[b];
        if ((yi > ys[i]) !== (yj > ys[i]) && xs[i] < ((xj - xi) * (ys[i] - yi)) / (yj - yi) + xi) inside = !inside;
      }
      out[i] = inside ? 1 : 0;
    }
    return out;
  }

  const shapes: Array<{ name: string; verts: Vertex[] }> = [
    { name: "a convex polygon", verts: [[40, 30], [200, 45], [180, 210], [60, 190]] },
    { name: "a polygon reaching past every end of the axes", verts: [[-40, -12], [290, -5], [300, 270], [-20, 300]] },
    { name: "a concave polygon", verts: [[20, 20], [230, 20], [230, 230], [130, 230], [130, 90], [70, 90], [70, 230], [20, 230]] },
    // Thinner than a channel between lattice points: its cells come apart into separate pieces.
    { name: "a sliver whose cells come apart", verts: [[10, 10], [250, 131], [250, 132.2], [10, 11.2]] },
    // A notch reaching one lattice point from outside between two others: a hole.
    { name: "a polygon with a hole in its cells", verts: [[40, 40], [120, 40], [120, 120], [80.2, 120], [80.2, 80], [79.8, 80], [79.8, 120], [40, 120]] },
  ];

  for (const spec of specs) {
    for (const shape of shapes) {
      it(`selects exactly the grid's events on a ${spec.axis.kind} axis: ${shape.name}`, () => {
        const sy = specs[(specs.indexOf(spec) + 1) % specs.length];
        const { xs, ys } = eventsFor(spec, sy);
        const want = gridMask(spec, sy, shape.verts, xs, ys);
        const nx = flowJoGridScale(spec).cells;
        const ny = flowJoGridScale(sy).cells;
        const cells = flowJoGridCells(nx, ny, (cx, cy) => pointInPolygon(cx, cy, shape.verts.map((v) => v[0]), shape.verts.map((v) => v[1])));
        const ring = flowJoGridRing(cells, nx, ny, flowJoGridEdges(spec), flowJoGridEdges(sy))!;
        expect(ring).not.toBeNull();
        const closed = gateMaskPolygon(xs, ys, ring);
        const halfOpen = halfOpenMask(xs, ys, ring);
        let wrongClosed = 0;
        let wrongHalf = 0;
        for (let i = 0; i < xs.length; i++) {
          if (closed[i] !== want[i]) wrongClosed++;
          if (halfOpen[i] !== want[i]) wrongHalf++;
        }
        expect(want.reduce((s, v) => s + v, 0)).toBeGreaterThan(0);
        expect(wrongClosed, "a closed reader (GateLab, Gating-ML)").toBe(0);
        expect(wrongHalf, "FlowKit's half-open reader").toBe(0);
      });
    }
  }

  it("joins pieces and holes into one ring", () => {
    const sliver = shapes[3].verts;
    const cells = flowJoGridCells(256, 256, (cx, cy) => pointInPolygon(cx, cy, sliver.map((v) => v[0]), sliver.map((v) => v[1])));
    const e = flowJoGridEdges(specs[0]);
    const ring = flowJoGridRing(cells, 256, 256, e, e)!;
    // More than one piece: the ring passes the same bridge twice.
    const seen = new Map<string, number>();
    for (const [a, b] of ring) seen.set(`${a},${b}`, (seen.get(`${a},${b}`) ?? 0) + 1);
    expect([...seen.values()].some((n) => n > 1)).toBe(true);
  });

  it("writes nothing for a polygon that selects no cell", () => {
    const cells = flowJoGridCells(256, 256, () => false);
    const e = flowJoGridEdges(specs[0]);
    expect(flowJoGridRing(cells, 256, 256, e, e)).toBeNull();
  });
});

// ── Where a ring's edge goes on a column that is not float32 ─────────────────────────────────

describe("a grid ring on an integer or float64 column", () => {
  // A 32-bit integer channel on a linear axis to 2^32: a channel is 2^24 integers wide, and above
  // 2^24 float32 cannot hold every integer, so an edge halfway between two float32 values can be an
  // integer, or put one on the wrong side.
  const spec = grid({ kind: "linear", minRange: 0, maxRange: 4294967296 });
  const s = flowJoGridScale(spec);
  const square: Vertex[] = [[3, 3], [250, 3], [250, 250], [3, 250]];

  /** Integer events: the last three of each channel and the first three of the next, on both axes. */
  function integerEvents(): { xs: Float64Array; ys: Float64Array } {
    const firsts: number[] = [];
    for (let c = 1; c < s.cells; c++) {
      let lo = 0;
      let hi = 4294967296;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (s.eventCell(mid) >= c) hi = mid;
        else lo = mid;
      }
      firsts.push(hi);
    }
    const near = firsts.flatMap((k) => [k - 3, k - 2, k - 1, k, k + 1, k + 2]);
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < near.length; i += 7) for (let j = 0; j < near.length; j += 11) { xs.push(near[i]); ys.push(near[j]); }
    for (const v of near) { xs.push(v); ys.push(firsts[125]); xs.push(firsts[125]); ys.push(v); }
    return { xs: Float64Array.from(xs), ys: Float64Array.from(ys) };
  }

  function wrongOnRing(values: "float32" | "integer" | "float64", xs: Float64Array, ys: Float64Array): { closed: number; halfOpen: number } {
    const want = gateMaskPolygon(Float64Array.from(xs, (v) => s.eventCell(v)), Float64Array.from(ys, (v) => s.eventCell(v)), square);
    const cells = flowJoGridCells(s.cells, s.cells, (cx, cy) => pointInPolygon(cx, cy, square.map((v) => v[0]), square.map((v) => v[1])));
    const e = flowJoGridEdges(spec, values);
    const ring = flowJoGridRing(cells, s.cells, s.cells, e, e)!;
    const closed = gateMaskPolygon(xs, ys, ring);
    let wc = 0;
    let wh = 0;
    for (let i = 0; i < xs.length; i++) {
      if (closed[i] !== want[i]) wc++;
      // FlowKit's half-open test
      let inside = false;
      for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
        const [xi, yi] = ring[a];
        const [xj, yj] = ring[b];
        if ((yi > ys[i]) !== (yj > ys[i]) && xs[i] < ((xj - xi) * (ys[i] - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if ((inside ? 1 : 0) !== want[i]) wh++;
    }
    return { closed: wc, halfOpen: wh };
  }

  it("puts every edge halfway between two integers, so both readers select exactly the grid's events", () => {
    const e = flowJoGridEdges(spec, "integer");
    for (let c = 1; c < s.cells; c++) {
      expect(e[c] - Math.floor(e[c]), `edge ${c}`).toBe(0.5);
      expect(s.eventCell(e[c] + 0.5)).toBe(c);
      expect(s.eventCell(e[c] - 0.5)).toBe(c - 1);
    }
    const { xs, ys } = integerEvents();
    expect(wrongOnRing("integer", xs, ys)).toEqual({ closed: 0, halfOpen: 0 });
    // Edges placed for float32 values put integers on the wrong side, or on the edge itself.
    const f32 = wrongOnRing("float32", xs, ys);
    expect(f32.closed + f32.halfOpen).toBeGreaterThan(0);
  });

  it("puts every edge on a float64 column at the first double of the next channel, which FlowKit's reader takes exactly", () => {
    const e = flowJoGridEdges(spec, "float64");
    const below = (v: number): number => {
      const f = new Float64Array([v]);
      const i = new BigInt64Array(f.buffer);
      i[0] = v > 0 ? i[0] - 1n : i[0] + 1n;
      return f[0];
    };
    for (let c = 1; c < s.cells; c++) {
      expect(s.eventCell(e[c]), `edge ${c}`).toBe(c);
      expect(s.eventCell(below(e[c]))).toBe(c - 1);
    }
    // Doubles on both sides of every edge, and on it.
    const vals: number[] = [];
    for (let c = 1; c < s.cells; c++) vals.push(below(e[c]), e[c], e[c] + 0.25);
    const xs: number[] = [];
    const ys: number[] = [];
    for (const v of vals) { xs.push(v); ys.push(e[128]); xs.push(e[128]); ys.push(v); }
    expect(wrongOnRing("float64", Float64Array.from(xs), Float64Array.from(ys)).halfOpen).toBe(0);
  });
});
