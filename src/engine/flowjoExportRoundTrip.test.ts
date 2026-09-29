// @vitest-environment jsdom
//
// A FlowJo workspace GateLab writes, read back with "Evaluate gates as FlowJo does" on (the
// default) and off. What GateLab evaluates continuously comes back as it was, whichever answer the
// import is given: its polygons carry GateLab's record (polygonRecord.ts), as its rectangles do.
// What GateLab evaluates by FlowJo's rule goes back as FlowJo saved it, and the import's answer
// decides again. The axes are declared so that FlowJo's own reading of the file stays close to
// GateLab's: a linear axis over FlowJo's default range, never an outlier's, and every axis with
// every digit. Synthetic channels, events and names throughout.

import { describe, expect, it } from "vitest";
import { Sample } from "./sample";
import { exportFlowJoWorkspace, type FlowJoExportSample } from "./flowjoExport";
import { flowJoWorkspaceToGatingML, type FlowJoImportOptions } from "./flowjoWorkspace";
import { importGatingML } from "./gatingml";
import { applyGatingStrategy } from "./populations";
import { isFlowJoGridGate } from "./flowjoGrid";
import { biexBreakpoints } from "./biex";
import { WSP_POLYGON_ATTR } from "./polygonRecord";
import {
  linkChildToParent, newGate, newGateRef, newPopulation, newRootPopulation,
  type Gate, type PolyRectGate, type PopulationMap, type Vertex,
} from "./models";
import type { FcsFile } from "./fcs";

const G = "http://www.isac-net.org/std/Gating-ML/v2.0/gating";
const D = "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes";
const T = "http://www.isac-net.org/std/Gating-ML/v2.0/transformations";

interface Tree { gates: Record<string, Gate>; gate_order: string[]; populations: PopulationMap; root_population_id: string }

/** A seeded generator, so every run draws the same synthetic events. */
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

/** Scatter and one fluorescence channel, with a few outliers far beyond $PnR on both sides. */
function scatterFile(): FcsFile {
  const r = rng(20260925);
  const fsc: number[] = [];
  const ssc: number[] = [];
  const fl: number[] = [];
  for (let i = 0; i < 20000; i++) {
    fsc.push(20000 + r() * 200000);
    ssc.push(-500 + r() * 180000);
    fl.push(-2000 + Math.exp(r() * 11));
  }
  // Outliers of the kind a baseline restoration leaves: one event decides a data extent.
  fsc.push(-44023416, 16962034, 3);
  ssc.push(5000, 5000, -4e6);
  fl.push(10, 10, 10);
  return {
    version: "FCS3.1", nEvents: fsc.length, instrument: "flow", keywords: { $CYT: "Synthetic cytometer" },
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
      { index: 2, name: "FITC-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [Float32Array.from(fsc), Float32Array.from(ssc), Float32Array.from(fl)],
    spillover: null,
  } as unknown as FcsFile;
}

function treeOf(gates: Gate[]): Tree {
  const root = newRootPopulation();
  let populations: PopulationMap = { [root.population_id]: root };
  for (const g of gates) {
    const p = newPopulation(g.name, [newGateRef(g.gate_id, true)], root.population_id, "and");
    populations[p.population_id] = p;
    populations = linkChildToParent(populations, p.population_id, root.population_id);
  }
  return { gates: Object.fromEntries(gates.map((g) => [g.gate_id, g])), gate_order: gates.map((g) => g.gate_id), populations, root_population_id: root.population_id };
}

function masksByName(sample: Sample, tree: Tree): Map<string, Uint8Array> {
  const { masks } = applyGatingStrategy(tree.gates, tree.populations, tree.root_population_id, sample.gateAssayData());
  const out = new Map<string, Uint8Array>();
  for (const [pid, pop] of Object.entries(tree.populations)) if (pid !== tree.root_population_id) out.set(pop.name.split("/").pop()!, masks[pid]);
  return out;
}

function importXml(xml: string, sample: Sample, options: FlowJoImportOptions): Tree {
  const conv = flowJoWorkspaceToGatingML(xml, 0, null, undefined, options);
  const pnn: Record<string, string> = {};
  for (const c of sample.channels) pnn[c.pnn] = c.key;
  const res = importGatingML(conv.gatingMl, sample.channels.map((c) => c.key), pnn, sample.instrument);
  return { gates: res.gates, gate_order: res.gate_order, populations: res.populations, root_population_id: res.root_population_id };
}

function exportXml(sample: Sample, tree: Tree): string {
  const entry: FlowJoExportSample = { sample, fileName: "D1.fcs", ...tree };
  return exportFlowJoWorkspace({ samples: [entry], now: new Date("2026-09-25T00:00:00Z") }).xml;
}

const differ = (a: Uint8Array, b: Uint8Array): number => a.reduce((n, v, i) => n + (v !== b[i] ? 1 : 0), 0);

/** Every population's events, before and after, compared by name. */
function moved(before: Map<string, Uint8Array>, after: Map<string, Uint8Array>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, m] of before) out[name] = after.has(name) ? differ(m, after.get(name)!) : -1;
  return out;
}

const zeros = (before: Map<string, Uint8Array>): Record<string, number> => Object.fromEntries([...before.keys()].map((k) => [k, 0]));

function linearAxis(xml: string, pnn: string): [number, number] {
  const m = xml.match(new RegExp(`<transforms:linear transforms:minRange="([^"]+)" transforms:maxRange="([^"]+)"[^>]*>\\s*<data-type:parameter data-type:name="${pnn}"`))!;
  return [Number(m[1]), Number(m[2])];
}

describe("a polygon GateLab evaluates continuously, through a FlowJo workspace", () => {
  const sample = new Sample(scatterFile());
  // Drawn in GateLab: raw on scatter, and one on the fluorescence display.
  const cells = newGate("Cells", "polygon", "FSC-A", "SSC-A", [[30000, 2000], [210000, 5000], [200000, 160000], [40000, 120000]]);
  const bright = { ...newGate("CD4_positive", "polygon", "FSC-A", "FITC-A", []), space: "display" as const, transforms: { "FSC-A": { kind: "asinh" as const, cofactor: 150 }, "FITC-A": sample.transformSpec("FITC-A") } };
  bright.vertices = [[5.0, sample.rawToGate(bright, "FITC-A", 500)], [7.5, sample.rawToGate(bright, "FITC-A", 800)], [7.3, sample.rawToGate(bright, "FITC-A", 40000)], [5.2, sample.rawToGate(bright, "FITC-A", 30000)]];
  const tree = treeOf([cells, bright]);
  const before = masksByName(sample, tree);

  it("comes back as it was with the option on, the default, and off", () => {
    expect(before.get("Cells")!.reduce((s, v) => s + v, 0)).toBeGreaterThan(1000);
    expect(before.get("CD4_positive")!.reduce((s, v) => s + v, 0)).toBeGreaterThan(100);
    const xml = exportXml(sample, tree);
    expect(xml).toContain(`${WSP_POLYGON_ATTR}="`);
    for (const flowJoGrid of [true, false]) {
      const back = importXml(xml, new Sample(scatterFile()), { flowJoGrid });
      expect(Object.values(back.gates).some((g) => isFlowJoGridGate(g as PolyRectGate)), `grid ${flowJoGrid}`).toBe(false);
      expect(moved(before, masksByName(new Sample(scatterFile()), back)), `grid ${flowJoGrid}`).toEqual(zeros(before));
      const cellsBack = Object.values(back.gates).find((g) => g.name === "Cells") as PolyRectGate;
      expect(cellsBack.vertices).toEqual(cells.vertices);
    }
  });

  it("is FlowJo's own polygon again once FlowJo has moved it, and the option decides", () => {
    const xml = exportXml(sample, tree).replace(/(<Population name="Cells"[\s\S]*?<gating:coordinate data-type:value=")([^"]+)(")/, (_, a, v, b) => `${a}${Number(v) + 1}${b}`);
    const on = importXml(xml, new Sample(scatterFile()), { flowJoGrid: true });
    expect(isFlowJoGridGate(Object.values(on.gates).find((g) => g.name === "Cells") as PolyRectGate)).toBe(true);
    const off = importXml(xml, new Sample(scatterFile()), { flowJoGrid: false });
    expect(isFlowJoGridGate(Object.values(off.gates).find((g) => g.name === "Cells") as PolyRectGate)).toBe(false);
  });

  it("declares a linear axis over FlowJo's default range, not over an outlier, reaching past a vertex near an end that has events beyond it", () => {
    const xml = exportXml(sample, tree);
    // FSC-A holds an outlier at -4.4e7 and one at 1.7e7: declaring the data's extent made FlowJo's
    // channel there 240,000 raw units wide.
    const [fmin, fmax] = linearAxis(xml, "FSC-A");
    expect(fmin).toBe(0);
    expect(fmax).toBe(262144);
    // "Cells" has a vertex at SSC-A 2000, within two channels of 0, and events lie below it: FlowJo
    // would move them onto channel 0, inside the polygon, so the axis reaches past it.
    const [smin, smax] = linearAxis(xml, "SSC-A");
    expect(smin).toBeLessThan(0);
    expect(smin).toBeGreaterThan(-10000);
    expect(smax).toBe(262144);
    // FlowJo's own reading of the file, on its grid, differs from GateLab's only near the edges.
    const fjReading = importXml(xml.replace(new RegExp(` ${WSP_POLYGON_ATTR}="[^"]*"`, "g"), ""), new Sample(scatterFile()), { flowJoGrid: true });
    const cellsMoved = differ(before.get("Cells")!, masksByName(new Sample(scatterFile()), fjReading).get("Cells")!);
    expect(cellsMoved).toBeLessThan(200);
  });

  it("reaches past a rectangle's bound at or beyond the default range, so FlowJo's clamp does not put the events beyond it on the bound", () => {
    // FSC-A holds an event below -3000 and one above 300000 (the outliers): both bounds are covered.
    const low = newGate("Low", "rectangle", "FSC-A", "SSC-A", [[-3000, -3000], [300000, -3000], [300000, 50000], [-3000, 50000]]);
    const xml = exportXml(sample, treeOf([low]));
    const [fmin, fmax] = linearAxis(xml, "FSC-A");
    expect(fmin).toBeLessThan(-3000);
    expect(fmax).toBeGreaterThan(300000);
  });

  it("keeps FlowJo's default range when many events lie past $PnR but no gate comes near it", () => {
    // Five per cent of FSC-A past $PnR, to 1.9e8: the data's 99.9th percentile put every polygon in
    // the bulk of such a file on one or two of FlowJo's channels.
    const file = scatterFile();
    const fsc = Float32Array.from(file.columns[0] as Float32Array);
    for (let i = 0; i < fsc.length; i += 20) fsc[i] = 3e5 + (i % 7) * 3e7;
    const wide = new Sample({ ...file, columns: [fsc, file.columns[1], file.columns[2]] } as FcsFile);
    const bulk = newGate("Bulk", "polygon", "FSC-A", "SSC-A", [[30000, 10000], [200000, 10000], [150000, 150000]]);
    const xml = exportXml(wide, treeOf([bulk]));
    expect(linearAxis(xml, "FSC-A")).toEqual([0, 262144]);
    const back = importXml(xml.replace(new RegExp(` ${WSP_POLYGON_ATTR}="[^"]*"`, "g"), ""), wide, { flowJoGrid: true });
    const before = masksByName(wide, treeOf([bulk])).get("Bulk")!;
    expect(differ(before, masksByName(wide, back).get("Bulk")!)).toBeLessThan(200);
  });

  it("leaves a bound with no event beyond it past the axis, rather than stretching the grid to it", () => {
    // FlowJo users drag a rectangle's edge far past the data; no event lies beyond 1.8e8, so FlowJo's
    // move onto the axis edge changes nothing there, and the polygon beside it keeps a fine grid.
    const wide = newGate("Wide", "rectangle", "FSC-A", "SSC-A", [[-1.9e9, 1000], [1.8e8, 1000], [1.8e8, 50000], [-1.9e9, 50000]]);
    const xml = exportXml(sample, treeOf([wide, cells]));
    const [fmin, fmax] = linearAxis(xml, "FSC-A");
    expect(fmin).toBe(0);
    expect(fmax).toBe(262144);
    const back = importXml(xml.replace(new RegExp(` ${WSP_POLYGON_ATTR}="[^"]*"`, "g"), "").replace(/ gatelabRectangle="[^"]*"/g, ""), new Sample(scatterFile()), { flowJoGrid: true });
    const after = masksByName(new Sample(scatterFile()), back);
    const wideBefore = masksByName(sample, treeOf([wide]));
    expect(differ(wideBefore.get("Wide")!, after.get("Wide")!)).toBe(0);
  });
});

// ── A FlowJo workspace imported with the option off, exported, and read again ──────────────────

/** A one-population FlowJo workspace in FlowJo's shape on FITC-A (biex) and SSC-A (linear). */
function flowJoWorkspace(gate: string, biexMax = "262144"): string {
  return `<Workspace xmlns:transforms="${T}" xmlns:data-type="${D}" xmlns:gating="${G}"><SampleList><Sample>
  <DataSet uri="file:D1.fcs"/>
  <Transformations>
    <transforms:linear transforms:minRange="0" transforms:maxRange="262144" gain="1"><data-type:parameter data-type:name="SSC-A"/></transforms:linear>
    <transforms:linear transforms:minRange="0" transforms:maxRange="262144" gain="1"><data-type:parameter data-type:name="FSC-A"/></transforms:linear>
    <transforms:biex transforms:length="256" transforms:maxRange="${biexMax}" transforms:neg="0" transforms:width="-100" transforms:pos="4.42"><data-type:parameter data-type:name="FITC-A"/></transforms:biex>
  </Transformations>
  <SampleNode name="D1.fcs" count="1"><Subpopulations>
    <Population name="Gated" count="1"><Gate>${gate}</Gate></Population>
  </Subpopulations></SampleNode></Sample></SampleList></Workspace>`;
}

const polygonXml = (vertices: Vertex[], attrs = 'quadId="-1" gateResolution="256"'): string =>
  `<gating:PolygonGate eventsInside="1" ${attrs} gating:id="g1">
    <gating:dimension><data-type:fcs-dimension data-type:name="FITC-A"/></gating:dimension>
    <gating:dimension><data-type:fcs-dimension data-type:name="SSC-A"/></gating:dimension>
    ${vertices.map(([x, y]) => `<gating:vertex><gating:coordinate data-type:value="${x}"/><gating:coordinate data-type:value="${y}"/></gating:vertex>`).join("")}
  </gating:PolygonGate>`;

describe("a FlowJo polygon imported with the option off, through a FlowJo workspace", () => {
  // A biex polygon with a vertex far below the table, where the display pins it at channel 0 and
  // pins the events below the table there too: the events that drifted off its edge.
  const params = { maxValue: 262144, pos: 4.42, neg: 0, widthBasis: -100, channelRange: 256, tableChannels: 4096 };
  const bottom = biexBreakpoints(params).raw[0];
  const wsp = flowJoWorkspace(polygonXml([[bottom * 30, 1000], [2000, 1000], [3000, 150000], [bottom * 30, 150000]]));

  it("comes back continuous and holding the same events, under either answer", () => {
    const sample = new Sample(scatterFile());
    const off = importXml(wsp, sample, { flowJoGrid: false });
    const before = masksByName(sample, off);
    const n = before.get("Gated")!.reduce((s, v) => s + v, 0);
    expect(n).toBeGreaterThan(100);
    const xml = exportXml(sample, off);
    for (const flowJoGrid of [false, true]) {
      const back = importXml(xml, new Sample(scatterFile()), { flowJoGrid });
      expect(moved(before, masksByName(new Sample(scatterFile()), back)), `grid ${flowJoGrid}`).toEqual({ Gated: 0 });
    }
  });

  it("declares every axis with every digit, so a vertex at the end of the display stays there", () => {
    // FlowJo's own biex top for the S8 is 9999999.999999998; at 15 digits it is another table.
    const sample = new Sample(scatterFile());
    const topped = flowJoWorkspace(polygonXml([[-1e6, 1000], [2000, 1000], [3000, 150000], [-1e6, 150000]], 'quadId="0" gateResolution="256"'), "9999999.999999998");
    const imported = importXml(topped, sample, { flowJoGrid: true });
    const before = masksByName(sample, imported);
    expect(before.get("Gated")!.reduce((s, v) => s + v, 0)).toBeGreaterThan(100);
    const xml = exportXml(sample, imported);
    expect(xml).toContain('transforms:maxRange="9999999.999999998"');
    const back = importXml(xml.replace(new RegExp(` ${WSP_POLYGON_ATTR}="[^"]*"`, "g"), ""), new Sample(scatterFile()), { flowJoGrid: true });
    expect(moved(before, masksByName(new Sample(scatterFile()), back))).toEqual({ Gated: 0 });
  });
});

// ── A FlowJo range (a histogram's gate, one dimension) under FlowJo's rule ──────────────────────

describe("a FlowJo range imported under FlowJo's rule, through a FlowJo workspace", () => {
  const rangeWsp = (min: string): string => `<Workspace xmlns:transforms="${T}" xmlns:data-type="${D}" xmlns:gating="${G}"><SampleList><Sample>
  <DataSet uri="file:D1.fcs"/>
  <Transformations>
    <transforms:log transforms:offset="3" transforms:decades="5"><data-type:parameter data-type:name="FITC-A"/></transforms:log>
    <transforms:linear transforms:minRange="0" transforms:maxRange="262144" gain="1"><data-type:parameter data-type:name="SSC-A"/></transforms:linear>
  </Transformations>
  <SampleNode name="D1.fcs" count="1"><Subpopulations>
    <Population name="Gated" count="1"><Gate>
      <gating:RectangleGate eventsInside="1" percentX="0" percentY="0" gating:id="r1">
        <gating:dimension gating:min="${min}" gating:max="5000"><data-type:fcs-dimension data-type:name="FITC-A"/></gating:dimension>
      </gating:RectangleGate></Gate></Population>
  </Subpopulations></SampleNode></Sample></SampleList></Workspace>`;

  it("goes back as FlowJo's range: one dimension, FlowJo's own bound where the rule opened it, FlowJo's axis, no GateLab record", () => {
    const sample = new Sample(scatterFile());
    const on = importXml(rangeWsp("3.0"), sample, { flowJoGrid: true });
    const gate = Object.values(on.gates)[0] as PolyRectGate;
    // The rule opened the bound at the offset; FlowJo's own value and axis ride with the gate.
    expect(gate.flowjo_bounds).toEqual({ "FITC-A": [3, null] });
    expect(gate.flowjo_axes).toEqual({ "FITC-A": { kind: "wsplog", offset: 3, decades: 5 } });
    const xml = exportXml(sample, on);
    const rect = xml.match(/<gating:RectangleGate[\s\S]*?<\/gating:RectangleGate>/)![0];
    expect(rect.match(/<gating:dimension\b/g)).toHaveLength(1);
    expect(rect).toMatch(/gating:min="3"/);
    expect(rect).toMatch(/gating:max="5000"/);
    expect(rect).not.toContain("gatelabRectangle");
    expect(xml).toMatch(/<transforms:log transforms:offset="3" transforms:decades="5">\s*<data-type:parameter data-type:name="FITC-A"/);
    // Read again, each answer gives what it gave the first time.
    for (const flowJoGrid of [true, false]) {
      const first = masksByName(new Sample(scatterFile()), importXml(rangeWsp("3.0"), new Sample(scatterFile()), { flowJoGrid }));
      const again = masksByName(new Sample(scatterFile()), importXml(xml, new Sample(scatterFile()), { flowJoGrid }));
      expect(moved(first, again), `grid ${flowJoGrid}`).toEqual({ Gated: 0 });
    }
  });
});

// A range on Time goes to FlowJo in seconds ($TIMESTEP applied), as FlowJo stores it. The import
// applied the step to a two-dimensional gate only, so the range came back as ticks equal to its
// seconds: every event of a window 20 to 60 s fell outside it.
describe("a range on Time, through a FlowJo workspace", () => {
  function timeFile(): FcsFile {
    const r = rng(20260926);
    const time: number[] = [];
    const ssc: number[] = [];
    for (let i = 0; i < 5000; i++) { time.push(Math.floor(r() * 10000)); ssc.push(r() * 100000); }
    return {
      version: "FCS3.1", nEvents: time.length, instrument: "flow", keywords: { $TIMESTEP: "0.01" },
      channels: [
        { index: 0, name: "Time", marker: null, bits: 32, range: 262144 },
        { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
      ],
      columns: [Float32Array.from(time), Float32Array.from(ssc)],
      spillover: null,
    } as unknown as FcsFile;
  }

  it("comes back over the same ticks under either answer", () => {
    const sample = new Sample(timeFile());
    const tree = treeOf([newGate("Window", "rectangle", "Time", "Time", [[2000, 2000], [6000, 6000]])]);
    const before = masksByName(sample, tree);
    expect(before.get("Window")!.reduce((s, v) => s + v, 0)).toBeGreaterThan(1000);
    const xml = exportXml(sample, tree);
    const rect = xml.match(/<gating:RectangleGate[\s\S]*?<\/gating:RectangleGate>/)![0];
    expect(rect.match(/<gating:dimension\b/g)).toHaveLength(1);
    expect(rect).toMatch(/gating:min="20"/);
    for (const flowJoGrid of [true, false]) {
      const back = importXml(xml, new Sample(timeFile()), { flowJoGrid });
      expect(moved(before, masksByName(new Sample(timeFile()), back)), `grid ${flowJoGrid}`).toEqual({ Window: 0 });
    }
  });
});

// A FlowJo Time rectangle whose upper bound FlowJo's range rule opened (b4b4868): FlowJo saves Time
// at its Time axis's gain (ticks x gain), and the importer kept that value as the bound FlowJo
// saved (PolyRectGate.flowjo_bounds), which the FlowJo export takes in raw units, ticks, and
// multiplies by $TIMESTEP. Both bounds collapsed onto one number, and every population beneath
// the gate lost its events on the way back (FR-FCM-Z2HV fc021-a_190806.wsp: written 0.7732 to
// 0.7732 where FlowJo saved 12.08 to 77.32; 303,866 events moved in 71 populations).
describe("a FlowJo Time rectangle whose bound FlowJo's range rule opened, through a FlowJo workspace", () => {
  // FR-FCM-Z2HV's numbers: gain 0.0102350064, axis 0.5107 to 77, the gate 12.0805 to 77.3214.
  const GAIN = 0.0102350064;
  const [LO, HI] = [12.080532845847822, 77.32138350076312];
  const wsp = `<Workspace xmlns:transforms="${T}" xmlns:data-type="${D}" xmlns:gating="${G}"><SampleList><Sample>
  <DataSet uri="file:D1.fcs"/><Keywords><Keyword name="$TIMESTEP" value="0.01"/></Keywords>
  <Transformations>
    <transforms:linear transforms:minRange="0.5107268184" transforms:maxRange="77" gain="${GAIN}"><data-type:parameter data-type:name="Time"/></transforms:linear>
    <transforms:linear transforms:minRange="0" transforms:maxRange="262144" gain="1"><data-type:parameter data-type:name="SSC-A"/></transforms:linear>
  </Transformations>
  <SampleNode name="D1.fcs" count="1"><Subpopulations>
    <Population name="Window" count="1"><Gate>
      <gating:RectangleGate eventsInside="1" percentX="0" percentY="0" gating:id="w1">
        <gating:dimension gating:min="${LO}" gating:max="${HI}"><data-type:fcs-dimension data-type:name="Time"/></gating:dimension>
        <gating:dimension gating:min="18204.444444444445" gating:max="229376"><data-type:fcs-dimension data-type:name="SSC-A"/></gating:dimension>
      </gating:RectangleGate></Gate>
      <Subpopulations><Population name="Beneath" count="1"><Gate>
        <gating:RectangleGate eventsInside="1" percentX="0" percentY="0" gating:id="b1">
          <gating:dimension gating:min="30000" gating:max="80000"><data-type:fcs-dimension data-type:name="SSC-A"/></gating:dimension>
        </gating:RectangleGate></Gate></Population></Subpopulations>
    </Population>
  </Subpopulations></SampleNode></Sample></SampleList></Workspace>`;
  /** Time in ticks up to `lastTick`, $TIMESTEP 0.01, and SSC-A. */
  const timeFile = (lastTick: number): FcsFile => {
    const r = rng(20260928);
    const time: number[] = [];
    const ssc: number[] = [];
    for (let i = 0; i < 5000; i++) { time.push(Math.floor(r() * (lastTick + 1))); ssc.push(r() * 100000); }
    time.push(lastTick);
    ssc.push(50000);
    return {
      version: "FCS3.1", nEvents: time.length, instrument: "flow", keywords: { $TIMESTEP: "0.01" },
      channels: [
        { index: 0, name: "Time", marker: null, bits: 32, range: 262144 },
        { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
      ],
      columns: [Float32Array.from(time), Float32Array.from(ssc)],
      spillover: null,
    } as unknown as FcsFile;
  };
  const timeDimension = (xml: string): string =>
    xml.match(/<gating:RectangleGate[^>]*gating:id="[^"]*">\s*<gating:dimension([^>]*)>\s*<data-type:fcs-dimension data-type:name="Time"/)![1];

  it("keeps FlowJo's saved bound in the file's ticks, raw units as every other opened bound", () => {
    const on = importXml(wsp, new Sample(timeFile(9999)), { flowJoGrid: true });
    const gate = Object.values(on.gates).find((g) => g.name === "Window") as PolyRectGate;
    expect(gate.flowjo_bounds).toEqual({ Time: [null, HI / GAIN] });
  });

  // Events past FlowJo's saved bound (7,554.6 ticks), up to 9,999: the export declares Time over
  // the data, to 99.99 s, and FlowJo's value would not reach it; the bound goes out as none.
  it("comes back with its events where the data reach past FlowJo's saved bound", () => {
    const sample = new Sample(timeFile(9999));
    const on = importXml(wsp, sample, { flowJoGrid: true });
    const before = masksByName(sample, on);
    expect(before.get("Window")!.reduce((s, v) => s + v, 0)).toBeGreaterThan(1000);
    expect(before.get("Beneath")!.reduce((s, v) => s + v, 0)).toBeGreaterThan(500);
    const xml = exportXml(sample, on);
    const dimension = timeDimension(xml);
    expect(Number(/gating:min="([^"]+)"/.exec(dimension)![1])).toBeCloseTo((LO / GAIN) * 0.01, 10);
    expect(dimension).not.toContain("gating:max");
    for (const flowJoGrid of [true, false]) {
      const back = importXml(xml, new Sample(timeFile(9999)), { flowJoGrid });
      expect(moved(before, masksByName(new Sample(timeFile(9999)), back)), `grid ${flowJoGrid}`).toEqual({ Window: 0, Beneath: 0 });
    }
  });

  // Every event within FlowJo's saved bound: the declared Time axis ends at the data's last tick,
  // below that bound, so FlowJo's value goes out, in the file's seconds at $TIMESTEP, and an import
  // of the file opens it again.
  it("writes FlowJo's saved bound at $TIMESTEP where it reaches past the declared Time axis", () => {
    const sample = new Sample(timeFile(7000));
    const on = importXml(wsp, sample, { flowJoGrid: true });
    const before = masksByName(sample, on);
    expect(before.get("Window")!.reduce((s, v) => s + v, 0)).toBeGreaterThan(1000);
    const xml = exportXml(sample, on);
    expect(Number(/gating:max="([^"]+)"/.exec(timeDimension(xml))![1])).toBe((HI / GAIN) * 0.01);
    for (const flowJoGrid of [true, false]) {
      const back = importXml(xml, new Sample(timeFile(7000)), { flowJoGrid });
      expect(moved(before, masksByName(new Sample(timeFile(7000)), back)), `grid ${flowJoGrid}`).toEqual({ Window: 0, Beneath: 0 });
    }
  });
});

// A log-axis polygon vertex at or below zero is far below the axis in a workspace FlowJo 10.2 or
// earlier wrote, and on the axis floor for FlowJo 10.6 and later (flowjoGrid.ts). The export kept
// the vertex FlowJo saved wherever it rounded onto the gate's channel by the scale alone, and
// declares FlowJo 10.10.0, whose floor then moved it: FR-FCM-ZZSX FMOs.wsp (10.0.7r2) moved 413
// events ("CD4+ T cells" 103) and FR-FCM-ZY9F 20150408.wsp (10.2) 1,365 through GateLab's own .wsp.
describe("a FlowJo grid polygon with a log vertex at or below zero, through a FlowJo workspace", () => {
  const n = 160;
  const logFile = (): FcsFile => {
    const xs = new Float32Array(n * n);
    const ys = new Float32Array(n * n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        xs[i * n + j] = Math.pow(10, (4.5 * i) / n);
        ys[i * n + j] = Math.pow(10, (4.5 * j) / n);
      }
    }
    return {
      version: "FCS3.1", nEvents: xs.length, instrument: "flow", keywords: {},
      channels: [
        { index: 0, name: "FITC-A", marker: null, bits: 32, range: 262144 },
        { index: 1, name: "PE-A", marker: null, bits: 32, range: 262144 },
      ],
      columns: [xs, ys],
      spillover: null,
    } as unknown as FcsFile;
  };
  const wsp = (version: string): string => `<Workspace xmlns:transforms="${T}" xmlns:data-type="${D}" xmlns:gating="${G}" flowJoVersion="${version}"><SampleList><Sample>
  <DataSet uri="file:D1.fcs"/>
  <Transformations>
    <transforms:log transforms:offset="1" transforms:decades="4.5"><data-type:parameter data-type:name="FITC-A"/></transforms:log>
    <transforms:log transforms:offset="1" transforms:decades="4.5"><data-type:parameter data-type:name="PE-A"/></transforms:log>
  </Transformations>
  <SampleNode name="D1.fcs" count="1"><Subpopulations>
    <Population name="Gated" count="1"><Gate>
      <gating:PolygonGate eventsInside="1" quadId="-1" gateResolution="256" gating:id="g1">
        <gating:dimension><data-type:fcs-dimension data-type:name="FITC-A"/></gating:dimension>
        <gating:dimension><data-type:fcs-dimension data-type:name="PE-A"/></gating:dimension>
        ${([[-93.44, 100], [5000, 3000], [5000, 20000], [10, 20000]] as Vertex[]).map(([x, y]) => `<gating:vertex><gating:coordinate data-type:value="${x}"/><gating:coordinate data-type:value="${y}"/></gating:vertex>`).join("")}
      </gating:PolygonGate></Gate></Population>
  </Subpopulations></SampleNode></Sample></SampleList></Workspace>`;

  // Read with the option off, the file gives what the source gave with the option off: the vertex
  // kept its other coordinate, FlowJo's own, where the whole vertex went to its channels' middles
  // (FlowJo 10.6.2: 8 events).
  for (const version of ["10.0.7r2", "10.2", "10.6.2"]) {
    it(`comes back holding the events it held from FlowJo ${version}, under either answer`, () => {
      const sample = new Sample(logFile());
      const on = importXml(wsp(version), sample, { flowJoGrid: true });
      expect(Object.values(on.gates).every((g) => isFlowJoGridGate(g as PolyRectGate))).toBe(true);
      const before = masksByName(sample, on);
      expect(before.get("Gated")!.reduce((s, v) => s + v, 0)).toBeGreaterThan(1000);
      const xml = exportXml(sample, on);
      const back = importXml(xml, new Sample(logFile()), { flowJoGrid: true });
      expect(moved(before, masksByName(new Sample(logFile()), back)), "grid on").toEqual({ Gated: 0 });
      const offBefore = masksByName(new Sample(logFile()), importXml(wsp(version), new Sample(logFile()), { flowJoGrid: false }));
      const offBack = importXml(xml, new Sample(logFile()), { flowJoGrid: false });
      expect(moved(offBefore, masksByName(new Sample(logFile()), offBack)), "grid off").toEqual({ Gated: 0 });
    });
  }
});

// Two FlowJo rectangles on one channel saved on different axes (two imports merged). A FlowJo file
// declares one axis per parameter; the export declared the first rectangle's, and wrote the other
// against it with no word: a bound of 500,000 on a 0 to 1,048,576 axis under a declared 0 to
// 262,144 took the events at 520,000, 800,000 and 2e6, which FlowJo moves onto 262,144.
describe("FlowJo rectangles on one channel saved on different axes, through a FlowJo workspace", () => {
  function wideFile(): FcsFile {
    const r = rng(20260927);
    const fsc: number[] = [];
    const ssc: number[] = [];
    for (let i = 0; i < 4000; i++) { fsc.push(r() * 300000); ssc.push(r() * 120000); }
    fsc.push(520000, 800000, 2e6, -5000);
    ssc.push(5000, 5000, 5000, 5000);
    return {
      version: "FCS3.1", nEvents: fsc.length, instrument: "flow", keywords: {},
      channels: [
        { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
        { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
      ],
      columns: [Float32Array.from(fsc), Float32Array.from(ssc)],
      spillover: null,
    } as unknown as FcsFile;
  }
  const wsp = (fscMax: number, population: string): string => `<Workspace xmlns:transforms="${T}" xmlns:data-type="${D}" xmlns:gating="${G}"><SampleList><Sample>
  <DataSet uri="file:D1.fcs"/>
  <Transformations>
    <transforms:linear transforms:minRange="0" transforms:maxRange="${fscMax}" gain="1"><data-type:parameter data-type:name="FSC-A"/></transforms:linear>
    <transforms:linear transforms:minRange="0" transforms:maxRange="262144" gain="1"><data-type:parameter data-type:name="SSC-A"/></transforms:linear>
  </Transformations>
  <SampleNode name="D1.fcs" count="1"><Subpopulations>${population}</Subpopulations></SampleNode></Sample></SampleList></Workspace>`;
  const rect = (name: string, fsc: [number, number]) => `<Population name="${name}" count="1"><Gate>
      <gating:RectangleGate eventsInside="1" percentX="0" percentY="0" gating:id="${name}_g">
        <gating:dimension gating:min="${fsc[0]}" gating:max="${fsc[1]}"><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
        <gating:dimension gating:min="1000" gating:max="100000"><data-type:fcs-dimension data-type:name="SSC-A"/></gating:dimension>
      </gating:RectangleGate></Gate></Population>`;
  const gridPolygon = `<Population name="Cells" count="1"><Gate>
      <gating:PolygonGate eventsInside="1" quadId="-1" gateResolution="256" gating:id="Cells_g">
        <gating:dimension><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
        <gating:dimension><data-type:fcs-dimension data-type:name="SSC-A"/></gating:dimension>
        <gating:vertex><gating:coordinate data-type:value="20000"/><gating:coordinate data-type:value="2000"/></gating:vertex>
        <gating:vertex><gating:coordinate data-type:value="250000"/><gating:coordinate data-type:value="2000"/></gating:vertex>
        <gating:vertex><gating:coordinate data-type:value="200000"/><gating:coordinate data-type:value="110000"/></gating:vertex>
      </gating:PolygonGate></Gate></Population>`;

  /** FlowJo's rectangle rule on the written file, independent of GateLab: clamp to the declared linear axis, then closed. */
  function flowJoRule(xml: string, sample: Sample, name: string): Uint8Array {
    const axis = (pnn: string) => linearAxis(xml, pnn);
    const block = xml.match(new RegExp(`<Population name="${name}"[\\s\\S]*?<gating:RectangleGate[\\s\\S]*?</gating:RectangleGate>`))![0];
    const dims = [...block.matchAll(/<gating:dimension([^>]*)>\s*<data-type:fcs-dimension data-type:name="([^"]+)"/g)].map((m) => ({
      pnn: m[2],
      min: /gating:min="([^"]+)"/.exec(m[1])?.[1],
      max: /gating:max="([^"]+)"/.exec(m[1])?.[1],
    }));
    const out = new Uint8Array(sample.fcs.nEvents).fill(1);
    for (const d of dims) {
      const [lo, hi] = axis(d.pnn);
      const column = sample.rawColumnData(sample.index(d.pnn)!);
      for (let i = 0; i < out.length; i++) {
        const v = Math.min(Math.max(column[i], lo), hi);
        if ((d.min !== undefined && v < Number(d.min)) || (d.max !== undefined && v > Number(d.max))) out[i] = 0;
      }
    }
    return out;
  }
  const gateOf = (tree: Tree, name: string): Gate => Object.values(tree.gates).find((g) => g.name === name)!;

  it("declares the widest axis, on which FlowJo's clamp keeps GateLab's events for both, and names the one moved", () => {
    const sample = new Sample(wideFile());
    const a = importXml(wsp(262144, rect("Wide", [0, 262144])), sample, { flowJoGrid: true });
    const b = importXml(wsp(1048576, rect("Upto", [100000, 500000])), sample, { flowJoGrid: true });
    const tree = treeOf([gateOf(a, "Wide"), gateOf(b, "Upto")]);
    const before = masksByName(sample, tree);
    // GateLab: "Upto" holds none of the events beyond 500,000; "Wide" holds every FSC-A value.
    expect(before.get("Upto")!.reduce((s, v) => s + v, 0)).toBeGreaterThan(100);
    const { xml, warnings } = exportFlowJoWorkspace({ samples: [{ sample, fileName: "D1.fcs", ...tree }], now: new Date("2026-09-25T00:00:00Z") });
    expect(linearAxis(xml, "FSC-A")).toEqual([0, 1048576]);
    for (const name of ["Wide", "Upto"]) {
      expect(differ(flowJoRule(xml, sample, name), before.get(name)!), name).toBe(0);
    }
    expect(warnings.join(" ")).toContain(`"Wide" was saved by FlowJo on an axis this file declares differently (FSC-A: saved on a linear axis from 0 to 262144, written against the declared linear axis from 0 to 1048576, where FlowJo's clamp keeps GateLab's events)`);
    expect(warnings.join(" ")).not.toContain(`"Upto" was saved`);
    // Read back by FlowJo's rule, the answer the two were imported under, both give GateLab's events.
    expect(moved(before, masksByName(new Sample(wideFile()), importXml(xml, new Sample(wideFile()), { flowJoGrid: true })))).toEqual({ Wide: 0, Upto: 0 });
  });

  it("keeps a grid polygon's axis, and names the events FlowJo's clamp there moves into the rectangle", () => {
    const sample = new Sample(wideFile());
    const a = importXml(wsp(262144, gridPolygon), sample, { flowJoGrid: true });
    const b = importXml(wsp(1048576, rect("Upto", [100000, 500000])), sample, { flowJoGrid: true });
    const tree = treeOf([gateOf(a, "Cells"), gateOf(b, "Upto")]);
    const { xml, warnings } = exportFlowJoWorkspace({ samples: [{ sample, fileName: "D1.fcs", ...tree }], now: new Date("2026-09-25T00:00:00Z") });
    expect(linearAxis(xml, "FSC-A")).toEqual([0, 262144]);
    expect(warnings.join(" ")).toContain(`"Upto" was saved by FlowJo on an axis this file declares differently (FSC-A: saved on a linear axis from 0 to 1048576, written against the declared linear axis from 0 to 262144, where FlowJo moves the 3 events of this file above 500000 onto the axis's edge and counts them inside it, as GateLab does not)`);
  });

  // The grid polygon's axis whatever comes first in gate order. A rectangle saved on another axis
  // ahead of the polygon had its own axis declared, and the polygon was gridded on it: FlowJo's
  // clamp there also moved the events at 520,000, 800,000 and 2e6 into "Upto", which the polygon's
  // own axis keeps apart.
  it("keeps a grid polygon's axis when a rectangle saved on another axis comes before it", () => {
    const sample = new Sample(wideFile());
    const a = importXml(wsp(262144, rect("Wide", [0, 262144])), sample, { flowJoGrid: true });
    const b = importXml(wsp(1048576, rect("Upto", [100000, 500000]) + gridPolygon), sample, { flowJoGrid: true });
    const tree = treeOf([gateOf(a, "Wide"), gateOf(b, "Upto"), gateOf(b, "Cells")]);
    const before = masksByName(sample, tree);
    const { xml, warnings } = exportFlowJoWorkspace({ samples: [{ sample, fileName: "D1.fcs", ...tree }], now: new Date("2026-09-25T00:00:00Z") });
    expect(linearAxis(xml, "FSC-A")).toEqual([0, 1048576]);
    for (const name of ["Wide", "Upto"]) {
      expect(differ(flowJoRule(xml, sample, name), before.get(name)!), name).toBe(0);
    }
    expect(warnings.join(" ")).toContain(`"Wide" was saved by FlowJo on an axis this file declares differently (FSC-A: saved on a linear axis from 0 to 262144, written against the declared linear axis from 0 to 1048576, where FlowJo's clamp keeps GateLab's events)`);
    expect(warnings.join(" ")).not.toContain(`"Upto" was saved`);
    // Read back by FlowJo's rule: every gate, the polygon on its own grid included, holds GateLab's events.
    expect(moved(before, masksByName(new Sample(wideFile()), importXml(xml, new Sample(wideFile()), { flowJoGrid: true })))).toEqual({ Wide: 0, Upto: 0, Cells: 0 });
  });
});

// ── A NOT of a population in another branch ────────────────────────────────────────────────────

describe("a NOT of a population in another branch, through a FlowJo workspace", () => {
  it("names that population by its path, as FlowJo's own NotNodes do, and comes back under its own names", () => {
    const sample = new Sample(scatterFile());
    const cells = newGate("Cells", "polygon", "FSC-A", "SSC-A", [[30000, 2000], [210000, 5000], [200000, 160000], [40000, 120000]]);
    const bright = newGate("Bright", "rectangle", "FSC-A", "FITC-A", [[-1e9, 500], [1e9, 500], [1e9, 1e9], [-1e9, 1e9]]);
    const big = newGate("Big", "rectangle", "FSC-A", "SSC-A", [[100000, -1e9], [1e9, -1e9], [1e9, 1e9], [100000, 1e9]]);
    const root = newRootPopulation();
    let pops: PopulationMap = { [root.population_id]: root };
    const add = (name: string, refs: { gate: Gate; include: boolean }[], parent: string): string => {
      const p = newPopulation(name, refs.map((r) => newGateRef(r.gate.gate_id, r.include)), parent, "and");
      pops[p.population_id] = p;
      pops = linkChildToParent(pops, p.population_id, parent);
      return p.population_id;
    };
    const cellsId = add("Cells", [{ gate: cells, include: true }], root.population_id);
    add("Bright", [{ gate: bright, include: true }], cellsId);
    const bigId = add("Big", [{ gate: big, include: true }], root.population_id);
    // Inside "Big", the events outside "Bright"'s gate: "Bright" is in another branch.
    add("Big not bright", [{ gate: bright, include: false }], bigId);
    const tree: Tree = { gates: { [cells.gate_id]: cells, [bright.gate_id]: bright, [big.gate_id]: big }, gate_order: [cells.gate_id, bright.gate_id, big.gate_id], populations: pops, root_population_id: root.population_id };
    const before = masksByName(sample, tree);
    expect(before.get("Big not bright")!.reduce((s, v) => s + v, 0)).toBeGreaterThan(100);
    const xml = exportXml(sample, tree);
    expect(xml).toContain('<Dependent name="Cells/Bright" />');
    // No helper population beside the NOT, under the name of the one it names.
    expect(xml.match(/<Population name="Bright"/g)).toHaveLength(1);
    for (const flowJoGrid of [true, false]) {
      const back = importXml(xml, new Sample(scatterFile()), { flowJoGrid });
      const names = Object.values(back.populations).map((p) => p.name).sort();
      expect(names, `grid ${flowJoGrid}`).toEqual(["All Events", "Big", "Big not bright", "Bright", "Cells"].sort());
      expect(moved(before, masksByName(new Sample(scatterFile()), back)), `grid ${flowJoGrid}`).toEqual(zeros(before));
    }
  });
});
