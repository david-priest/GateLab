// @vitest-environment jsdom
//
// $PnG at the Gating-ML boundary. GateLab gates stored values (FlowJo's convention); a standard
// Gating-ML file is on FCS scale values, stored value / $PnG. The ISAC conformance suite is the
// oracle where the testing library carries it; every other fixture here is synthetic (channels
// FSC-A/SSC-A/FL1-A/FL2-A, no real sample).

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "fflate";
import { parseFcs, type FcsFile } from "./fcs";
import { Sample, transformFromSpec } from "./sample";
import { gatingMLImportOptionsFor, importGatingML } from "./gatingml";
import { exportGatingML } from "./gatingmlExport";
import {
  gatesFromGatingMlScale,
  gatingMlGainConvention,
  gatingMlGains,
} from "./gatingmlGain";
import { gatingMLWriterOf } from "./gatingmlWriter";
import { getGateMask } from "./gates";
import {
  UNBOUNDED,
  linkChildToParent,
  newGateRef,
  newPopulation,
  newRootPopulation,
  type Gate,
  type PolyRectGate,
  type PopulationMap,
  type TransformSpec,
  type RectangleBounds,
} from "./models";
import { FIXTURES_ROOT } from "../testFixtures";

const mask = (sample: Sample, gate: Gate): Uint8Array => getGateMask(gate, sample.gateAssayData().forGate(gate));
const count = (m: Uint8Array): number => m.reduce((a, v) => a + v, 0);

// ── The ISAC suite: data1.fcs carries $P1G = 3.67 (FSC-H) and $P2G = 8 (SSC-H) ──────────

const ISAC_ARCHIVE = join(FIXTURES_ROOT, "PUBLIC - ISAC Gating-ML conformance", "gatingMLData_2.38.0.tar.gz");

/** The members of a gzipped tar archive whose paths end with one of `wanted`. */
function untar(path: string, wanted: string[]): Map<string, Uint8Array> {
  const tar = gunzipSync(readFileSync(path));
  const out = new Map<string, Uint8Array>();
  const text = (a: number, b: number) => new TextDecoder().decode(tar.subarray(a, b)).replace(/\0.*$/s, "");
  for (let off = 0; off + 512 <= tar.length;) {
    const name = text(off, off + 100);
    if (!name) break;
    const prefix = text(off + 345, off + 500);
    const size = parseInt(text(off + 124, off + 136).trim() || "0", 8);
    const full = prefix ? `${prefix}/${name}` : name;
    const hit = wanted.find((w) => full.endsWith(w));
    if (hit) out.set(hit, tar.slice(off + 512, off + 512 + size));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

describe.runIf(existsSync(ISAC_ARCHIVE))("Gating-ML gain — the ISAC suite's own gates on data1.fcs", () => {
  const ids = ["Range1", "Rectangle1", "Polygon4"];
  const files = untar(ISAC_ARCHIVE, [
    "FCSFiles/data1.fcs",
    "Gating-MLFiles/gates1.xml",
    ...ids.map((id) => `ExpectedResults/set_1/Results_${id}.txt`),
  ]);
  const fcsBytes = files.get("FCSFiles/data1.fcs")!;
  const sample = new Sample(parseFcs(fcsBytes.buffer.slice(fcsBytes.byteOffset, fcsBytes.byteOffset + fcsBytes.byteLength) as ArrayBuffer));
  const xml = new TextDecoder().decode(files.get("Gating-MLFiles/gates1.xml")!);

  /** One gate of gates1.xml on its own, with the file's transforms. */
  function solo(id: string): string {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const root = doc.documentElement;
    const keep = root.cloneNode(false) as Element;
    for (const el of Array.from(root.children)) {
      const gid = el.getAttributeNS("http://www.isac-net.org/std/Gating-ML/v2.0/gating", "id");
      if (!/Gate$/.test(el.localName) || gid === id) keep.appendChild(el.cloneNode(true));
    }
    return new XMLSerializer().serializeToString(keep);
  }

  it("reads the suite as a file on scale values, and finds the two gains", () => {
    expect(gatingMlGainConvention(xml)).toBe("scale");
    const pnnOf = (key: string) => sample.channels.find((c) => c.key === key)!.pnn;
    expect(Object.fromEntries([...gatingMlGains(sample)].map(([k, g]) => [pnnOf(k), g])))
      .toEqual({ "FSC-H": 3.67, "SSC-H": 8 });
  });

  for (const id of ids) {
    it(`${id}: every event matches the suite's expected membership once the gate is on stored values`, () => {
      const text = solo(id);
      const imported = importGatingML(text, sample.channels.map((c) => c.key),
        Object.fromEntries(sample.channels.map((c) => [c.pnn, c.key])), "flow");
      const truth = new TextDecoder().decode(files.get(`ExpectedResults/set_1/Results_${id}.txt`)!)
        .split("\n").map((s) => s.trim()).filter(Boolean).map((s) => (s === "1" ? 1 : 0));
      const { gates } = gatesFromGatingMlScale(imported.gates, gatingMlGains(sample));
      const gate = Object.values(gates)[0];
      const m = mask(sample, gate);
      let differ = 0;
      for (let i = 0; i < m.length; i++) if (m[i] !== truth[i]) differ++;
      expect(differ).toBe(0);
      // Taken as stored values, as GateLab read every Gating-ML file until 2026-09, it is far off:
      // Range1 held 12,446 events against the suite's 440.
      const unconverted = mask(sample, Object.values(imported.gates)[0]);
      expect(count(unconverted)).not.toBe(count(m));
    });
  }
});

// ── Which files are on scale values ────────────────────────────────────────────

const GML_HEAD =
  '<?xml version="1.0" encoding="UTF-8"?>\n<gating:Gating-ML xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"' +
  ' xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">';

describe("gatingMlGainConvention", () => {
  it("reads a file from any other writer on scale values, as the standard defines them", () => {
    expect(gatingMlGainConvention(`${GML_HEAD}</gating:Gating-ML>`)).toBe("scale");
  });

  it("reads GateLab's and GateLabR's files from before the mark on stored values", () => {
    expect(gatingMlGainConvention(
      `${GML_HEAD}<data-type:custom_info><gatelabr_scales><definition>{}</definition></gatelabr_scales></data-type:custom_info></gating:Gating-ML>`,
    )).toBe("stored");
    expect(gatingMlGainConvention(
      `${GML_HEAD}<data-type:custom_info><cytobank><about>Gating-ML 2.0 export from GateLab (standard / re-importable)</about></cytobank></data-type:custom_info></gating:Gating-ML>`,
    )).toBe("stored");
  });

  it("follows GateLab's mark where there is one", () => {
    expect(gatingMlGainConvention(
      `${GML_HEAD}<data-type:custom_info><gatelabr_scales/><gatelab_format>{"gain":"gating-ml"}</gatelab_format></data-type:custom_info></gating:Gating-ML>`,
    )).toBe("scale");
  });

  it("leaves a Cytobank file on stored values, where it has always been read", () => {
    // Cytobank's own mark, its about line (gatingmlWriter.ts): a cytobank block in a gate alone is
    // also what GateLab's standard format writes, and says nothing about the writer.
    expect(gatingMlGainConvention(
      `${GML_HEAD}<data-type:custom_info><cytobank><about>Gating-ML 2.0 export of Cytobank experiment number 1.</about></cytobank></data-type:custom_info>` +
      `<gating:RectangleGate gating:id="G"><data-type:custom_info><cytobank><name>G</name></cytobank></data-type:custom_info></gating:RectangleGate></gating:Gating-ML>`,
    )).toBe("stored");
  });

  // FlowJo's Gating-ML export, as FlowJo 10 writes it: every gate element carries FlowJo's own
  // un-namespaced attributes. Synthetic channels and coordinates.
  const FLOWJO = `${GML_HEAD}
    <gating:PolygonGate eventsInside="1"  annoOffsetX="53"  annoOffsetY="110"  tint="#000000"  isTinted="0"  lineWeight="Normal"  userDefined="1"  quadId="-1"  gateResolution="256"  gating:id="ID1">
      <gating:dimension><data-type:fcs-dimension data-type:name="FSC-A" /></gating:dimension>
      <gating:dimension><data-type:fcs-dimension data-type:name="SSC-A" /></gating:dimension>
      <gating:vertex><gating:coordinate data-type:value="100" /><gating:coordinate data-type:value="100" /></gating:vertex>
      <gating:vertex><gating:coordinate data-type:value="900" /><gating:coordinate data-type:value="100" /></gating:vertex>
      <gating:vertex><gating:coordinate data-type:value="500" /><gating:coordinate data-type:value="900" /></gating:vertex>
    </gating:PolygonGate></gating:Gating-ML>`;
  // flowUtils::write.gatingML: an info element under custom_info names the writer.
  const FLOWUTILS = `${GML_HEAD}<data-type:custom_info><info>Gating-ML 2.0 export generated by R/flowUtils/flowCore</info><R-version>R version 4.4.1 (2024-06-14)</R-version></data-type:custom_info>
    <gating:RectangleGate gating:id="G1">
      <gating:dimension gating:min="100" gating:max="900"><data-type:fcs-dimension data-type:name="FSC-A" /></gating:dimension>
    </gating:RectangleGate></gating:Gating-ML>`;

  it("recognises FlowJo's and flowUtils' Gating-ML and reads them on stored values (default pending David)", () => {
    expect(gatingMLWriterOf(FLOWJO)).toBe("flowjo");
    expect(gatingMlGainConvention(FLOWJO)).toBe("stored");
    expect(gatingMLWriterOf(FLOWUTILS)).toBe("flowutils");
    expect(gatingMlGainConvention(FLOWUTILS)).toBe("stored");
  });

  it("does not take a standard file's namespaced attributes or another info text for either writer", () => {
    const standard = `${GML_HEAD}<data-type:custom_info><info>written by hand</info></data-type:custom_info>
      <gating:RectangleGate gating:id="G1" gating:parent_id="G0">
        <gating:dimension gating:min="1" gating:max="2"><data-type:fcs-dimension data-type:name="FSC-A" /></gating:dimension>
      </gating:RectangleGate></gating:Gating-ML>`;
    expect(gatingMLWriterOf(standard)).toBe("unidentified");
    expect(gatingMlGainConvention(standard)).toBe("scale");
    // A GateLab mark still decides over the writer.
    const marked = FLOWUTILS.replace("</data-type:custom_info>", '<gatelab_format>{"gain":"gating-ml"}</gatelab_format></data-type:custom_info>');
    expect(gatingMlGainConvention(marked)).toBe("scale");
  });
});

// ── A float channel stating a log $PnE: no gain, at the Gating-ML boundary either ──────

describe("gatingMlGains on a float channel whose source states a log $PnE", () => {
  it("leaves out a Muse-shaped HLog channel and keeps its linear HLin twin", () => {
    // FSC-HLog holds log10(FSC-HLin) with the same $PnG 2.95. log10(HLin / 2.95) is HLog − 0.47,
    // not HLog / 2.95, so dividing a coordinate on it by the gain is no scale value.
    const lin = Float32Array.from([59.69, 155.8, 3188.3]);
    const fcs: FcsFile = {
      version: "FCS3.0",
      nEvents: 3,
      instrument: "flow",
      keywords: { $DATATYPE: "F", $P1E: "0.0,0.0", $P1G: "2.95", $P2E: "4.0,1.0", $P2G: "2.95", $P2R: "10000" },
      spillover: null,
      channels: [
        { index: 0, name: "FSC-HLin", marker: null, bits: 32, range: 10000, gain: 2.95 },
        { index: 1, name: "FSC-HLog", marker: null, bits: 32, range: 10000, gain: 2.95 },
      ],
      columns: [lin, Float32Array.from(lin, Math.log10)],
    };
    const sample = new Sample(fcs);
    expect([...gatingMlGains(sample)].map(([key, g]) => [sample.channels.find((c) => c.key === key)!.pnn, g]))
      .toEqual([["FSC-HLin", 2.95]]);
  });
});

// ── GateLab's own export and import agree, and state scale values ───────────────

function gainSample(): Sample {
  const n = 400;
  const col = (f: (i: number) => number) => Float32Array.from({ length: n }, (_, i) => f(i));
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents: n,
    instrument: "flow",
    keywords: { $P1G: "5", $P3G: "2" },
    spillover: null,
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 1048576, gain: 5 },
      { index: 1, name: "SSC-A", marker: null, bits: 32, range: 1048576 },
      { index: 2, name: "FL1-A", marker: "M1", bits: 32, range: 262144, gain: 2 },
      { index: 3, name: "FL2-A", marker: "M2", bits: 32, range: 262144 },
      { index: 4, name: "Time", marker: null, bits: 32, range: 262144, gain: 0.01 },
    ],
    columns: [
      col((i) => 1000 + (i * 2477) % 200000),
      col((i) => 500 + (i * 1181) % 150000),
      col((i) => -200 + (i * 7919) % 40000),
      col((i) => -100 + (i * 3571) % 30000),
      col((i) => i),
    ],
  };
  return new Sample(fcs);
}

function strategy(sample: Sample): { gates: Record<string, Gate>; order: string[]; populations: PopulationMap; root: string } {
  const fl = sample.transformSpec("M1");
  const fl2 = sample.transformSpec("M2");
  const gates: Record<string, Gate> = {
    scatter: {
      gate_id: "scatter", name: "Scatter", gate_type: "rectangle", x_channel: "FSC-A", y_channel: "SSC-A",
      vertices: [[20000, 10000], [150000, 10000], [150000, 120000], [20000, 120000]],
      space: "raw", color: "#000000", label_offset: null,
    },
    fluor: {
      gate_id: "fluor", name: "M1 pos", gate_type: "polygon", x_channel: "M1", y_channel: "M2",
      vertices: [[0.3, 0.1], [0.9, 0.1], [0.9, 0.8], [0.4, 0.7]],
      space: "display", transforms: { M1: fl, M2: fl2 }, color: "#000000", label_offset: null,
    },
  };
  const root = newRootPopulation();
  let populations: PopulationMap = { [root.population_id]: root };
  const a = newPopulation("Scatter", [newGateRef("scatter", true)], root.population_id, "and");
  populations[a.population_id] = a;
  populations = linkChildToParent(populations, a.population_id, root.population_id);
  const b = newPopulation("M1 pos", [newGateRef("fluor", true)], a.population_id, "and");
  populations[b.population_id] = b;
  populations = linkChildToParent(populations, b.population_id, a.population_id);
  return { gates, order: ["scatter", "fluor"], populations, root: root.population_id };
}

describe("Gating-ML export and import across a gain", () => {
  it("writes the standard format on scale values, marked, and reads it back to the same events", () => {
    const sample = gainSample();
    expect(Object.fromEntries(gatingMlGains(sample))).toEqual({ "FSC-A": 5, M1: 2 });
    const s = strategy(sample);
    const xml = exportGatingML({
      gates: s.gates, gate_order: s.order, populations: s.populations, root_population_id: s.root,
      sample, format: "standard", timestamp: "2026-01-01T00:00:00",
    });
    // The mark is fix/gatingml-hardening's gatelab_format, with this branch's `gain` key beside the
    // others (gatingMlGainConvention reads only `gain`).
    expect(xml).toMatch(/<gatelab_format>\{[^<]*"gain":"gating-ml"[^<]*\}<\/gatelab_format>/);
    // FSC-A 20000 is written as 20000 / 5; SSC-A, with no gain, as it is.
    expect(xml).toContain('gating:min="4000"');
    expect(xml).toContain('gating:min="10000"');
    expect(gatingMlGainConvention(xml)).toBe("scale");

    const imported = importGatingML(xml, sample.channels.map((c) => c.key),
      Object.fromEntries(sample.channels.map((c) => [c.pnn, c.key])), "flow");
    const back = gatesFromGatingMlScale(imported.gates, gatingMlGains(sample)).gates;
    const byName = (name: string) => Object.values(back).find((g) => g.name === name)!;
    for (const name of ["Scatter", "M1 pos"]) {
      const original = mask(sample, Object.values(s.gates).find((g) => g.name === name)!);
      expect(count(original)).toBeGreaterThan(0);
      expect(Array.from(mask(sample, byName(name)))).toEqual(Array.from(original));
    }
  });

  it("keeps the Cytobank format on stored values, since Cytobank's reading of $PnG is unknown", () => {
    const sample = gainSample();
    const s = strategy(sample);
    const xml = exportGatingML({
      gates: s.gates, gate_order: s.order, populations: s.populations, root_population_id: s.root,
      sample, format: "cytobank", timestamp: "2026-01-01T00:00:00",
    });
    // The Cytobank format carries the tree's gatelab_format mark (fix/gatingml-fidelity), with no gain.
    expect(xml).not.toContain('"gain"');
    expect(xml).toContain('gating:min="20000"');
    expect(gatingMlGainConvention(xml)).toBe("stored");
  });

  it("leaves an open range bound open, and scales a transform's top of scale instead of its coordinates", () => {
    // An open side is held as UNBOUNDED (fix/gatingml-hardening); ±1e9, the stand-in before it, is a
    // coordinate like any other, and real raw values reach past it (a width on the public S8 file
    // reaches -2.15e9), so it is scaled.
    const gates: Record<string, Gate> = {
      range: {
        gate_id: "range", name: "Range", gate_type: "rectangle", x_channel: "FSC-A", y_channel: "FSC-A",
        vertices: [[100, 100], [UNBOUNDED, 100], [UNBOUNDED, UNBOUNDED], [100, UNBOUNDED]], space: "raw", color: "#000", label_offset: null,
      },
      wide: {
        gate_id: "wide", name: "Wide", gate_type: "rectangle", x_channel: "FSC-A", y_channel: "FSC-A",
        vertices: [[-2e9, -2e9], [1e9, -2e9], [1e9, 1e9], [-2e9, 1e9]], space: "raw", color: "#000", label_offset: null,
      },
      lg: {
        gate_id: "lg", name: "Logicle", gate_type: "rectangle", x_channel: "M1", y_channel: "M2",
        vertices: [[0.2, 0.2], [0.6, 0.2], [0.6, 0.6], [0.2, 0.6]], space: "display",
        transforms: { M1: { kind: "logicle", T: 262144, W: 0.5, M: 4.5, A: 0 }, M2: { kind: "logicle", T: 262144, W: 0.5, M: 4.5, A: 0 } },
        color: "#000", label_offset: null,
      },
    };
    const { gates: out, converted } = gatesFromGatingMlScale(gates, new Map([["FSC-A", 3.67], ["M1", 2]]));
    expect(converted).toEqual(["Range", "Wide", "Logicle"]);
    const range = out.range as Extract<Gate, { vertices: unknown }>;
    expect(range.vertices[0]).toEqual([367, 367]);
    expect(range.vertices[2]).toEqual([UNBOUNDED, UNBOUNDED]);
    const wide = out.wide as Extract<Gate, { vertices: unknown }>;
    expect(wide.vertices[0]).toEqual([-2e9 * 3.67, -2e9 * 3.67]);
    expect(wide.vertices[2]).toEqual([1e9 * 3.67, 1e9 * 3.67]);
    const lg = out.lg as Extract<Gate, { vertices: unknown }>;
    expect(lg.vertices).toEqual((gates.lg as Extract<Gate, { vertices: unknown }>).vertices);
    expect(lg.transforms?.M1).toEqual({ kind: "logicle", T: 524288, W: 0.5, M: 4.5, A: 0 });
    expect(lg.transforms?.M2).toEqual({ kind: "logicle", T: 262144, W: 0.5, M: 4.5, A: 0 });
  });
});

// ── A gain and GateLab's own record of a rectangle ──────────────────────────────────────────

// GateLab's record of a rectangle (rectangleRecord.ts, fix/gate-edge-semantics) restores it exactly
// only where the file still states the bounds GateLab wrote. The standard format writes a channel
// with a gain on scale values (stored / $PnG), and the app restated the gates on stored values only
// after the import had checked the record, against the scale values: on every such channel it was
// refused, and the gate came back as the file's geometry times the gain. The importer now restates
// them (options.gains) before the record is checked. The export placed, densified and skirted a
// gate written in raw space in stored units while writing it in scale values (withGain carried
// only `convert`), so a gate on a FlowJo log or flog floor or a biex axis also came back elsewhere.
describe("a gain and GateLab's own record of a rectangle", () => {
  const importAsApp = (xml: string, sample: Sample) => importGatingML(
    xml, sample.channels.map((c) => c.key), Object.fromEntries(sample.channels.map((c) => [c.pnn, c.key])), "flow",
    { ...gatingMLImportOptionsFor(sample), gains: gatingMlGains(sample) },
  );
  const roundTrip = (sample: Sample, gate: Gate) => {
    const root = newRootPopulation();
    let populations: PopulationMap = { [root.population_id]: root };
    const pop = newPopulation(gate.name, [newGateRef(gate.gate_id, true)], root.population_id, "and");
    populations[pop.population_id] = pop;
    populations = linkChildToParent(populations, pop.population_id, root.population_id);
    const xml = exportGatingML({
      gates: { [gate.gate_id]: gate }, gate_order: [gate.gate_id], populations, root_population_id: root.population_id,
      sample, format: "standard", timestamp: "2026-01-01T00:00:00",
    });
    const res = importAsApp(xml, sample);
    return { xml, res, back: Object.values(res.gates)[0] };
  };

  for (const rule of ["closed", "half-open"] as RectangleBounds[]) {
    it(`brings a ${rule} raw rectangle on a channel with a gain back exactly, the events on its edges included`, () => {
      const sample = gainSample();
      const fsc = sample.rawColumnData(0);
      const ssc = sample.rawColumnData(1);
      // Edges on events' own values on both axes: FSC-A (gain 5) and SSC-A (no gain).
      const gate: PolyRectGate = {
        gate_id: "box", name: "Box", gate_type: "rectangle", x_channel: "FSC-A", y_channel: "SSC-A",
        vertices: [[fsc[7], ssc[3]], [fsc[40], ssc[3]], [fsc[40], ssc[91]], [fsc[7], ssc[91]]],
        space: "raw", bounds: rule, color: "#000000", label_offset: null,
      };
      const onEdge = Array.from(fsc).filter((v) => v === fsc[7] || v === fsc[40]).length;
      expect(onEdge).toBeGreaterThan(1);
      const { res, back } = roundTrip(sample, gate);
      expect(res.gain?.converted).toEqual(["Box"]);
      expect(back.gate_type === "rectangle" && back.vertices).toEqual(gate.vertices);
      expect(back.gate_type === "rectangle" && back.bounds).toBe(rule);
      expect(Array.from(mask(sample, back))).toEqual(Array.from(mask(sample, gate)));
    });
  }

  it("brings a flog rectangle at the floor of a channel with a gain back with the same events", () => {
    const sample = gainSample();
    const flog = { kind: "flog" as const, T: 262144, M: 4.5 };
    // Its lower x edge at flog's floor, so the export writes that axis in raw space there, with the
    // floor left open, and its upper edge from the clamp's raw value (clampedAxis).
    const gate: PolyRectGate = {
      gate_id: "floor", name: "Floor", gate_type: "rectangle", x_channel: "M1", y_channel: "M2",
      vertices: [[0, 0.3], [0.7, 0.3], [0.7, 0.8], [0, 0.8]],
      space: "display", transforms: { M1: flog, M2: flog }, bounds: "closed", color: "#000000", label_offset: null,
    };
    const before = mask(sample, gate);
    expect(count(before)).toBeGreaterThan(0);
    const { xml, back } = roundTrip(sample, gate);
    // FL1-A written in raw space, on its scale values: the edge's raw value over the gain of 2.
    const dim = /<gating:dimension(?![^>]*transformation-ref)[^>]*gating:max="([^"]+)"[^>]*>\s*<data-type:fcs-dimension data-type:name="FL1-A"/.exec(xml);
    expect(dim).not.toBeNull();
    const raw = 262144 * 10 ** ((0.7 - 1) * 4.5);
    expect(Math.abs(Number(dim![1]) - raw / 2) / (raw / 2)).toBeLessThan(1e-6);
    expect(Array.from(mask(sample, back))).toEqual(Array.from(before));
  });

  // A polygon with one axis written in raw space (FlowJo's biex) is densified and held to the
  // exported file's events as GateLab reads them back (densifyForExport's check.back, readBack). On
  // a transformed axis with a gain, readBack applied the transform declared on scale values to the
  // stored values, at twice the value here, so the check held the polygon to events where GateLab
  // does not read them: 2,496 vertices written where 371 hold the same events without the gain.
  const polygonSample = (gain: number) => {
    const n = 40000;
    const col = (f: (i: number) => number) => Float32Array.from({ length: n }, (_, i) => f(i));
    return new Sample({
      version: "FCS3.1", nEvents: n, instrument: "flow", keywords: gain === 1 ? {} : { $P3G: String(gain) }, spillover: null,
      channels: [
        { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
        { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
        { index: 2, name: "FL1-A", marker: "M1", bits: 32, range: 262144, ...(gain === 1 ? {} : { gain }) },
        { index: 3, name: "FL2-A", marker: "M2", bits: 32, range: 262144 },
      ],
      columns: [
        col((i) => 1000 + (i * 2477) % 200000),
        col((i) => 500 + (i * 1181) % 150000),
        col((i) => 10 ** (((i * 7919) % 40000) / 8000) - 20),
        col((i) => 10 ** (((i * 3571) % 30000) / 6000) - 10),
      ],
    } as FcsFile);
  };
  for (const [label, y] of [
    ["arcsinh", { kind: "asinh", cofactor: 150 }],
    ["logicle", { kind: "logicle", T: 262144, W: 0.5, M: 4.5, A: 0 }],
    ["flog", { kind: "flog", T: 262144, M: 4.5 }],
  ] as [string, TransformSpec][]) {
    it(`densifies a polygon whose ${label} axis is on a channel with a gain as it does without, and brings it back`, () => {
      const x: TransformSpec = { kind: "biex", maxValue: 262144, pos: 4.5, neg: 0, widthBasis: -10, channelRange: 256 };
      const fx = transformFromSpec(x).forward;
      const fy = transformFromSpec(y).forward;
      const gate: Gate = {
        gate_id: "poly", name: "Poly", gate_type: "polygon", x_channel: "M2", y_channel: "M1",
        vertices: [[fx(30), fy(40)], [fx(20000), fy(90)], [fx(60000), fy(30000)], [fx(900), fy(8000)]],
        space: "display", transforms: { M2: x, M1: y }, color: "#000000", label_offset: null,
      };
      const vertices = (xml: string) => (xml.match(/<gating:vertex>/g) ?? []).length;
      const plain = roundTrip(polygonSample(1), gate);
      const sample = polygonSample(2);
      const before = mask(sample, gate);
      expect(count(before)).toBeGreaterThan(1000);
      const { xml, res, back } = roundTrip(sample, gate);
      expect(res.gain?.converted).toEqual(["Poly"]);
      expect(vertices(xml)).toBe(vertices(plain.xml));
      let differ = 0;
      const after = mask(sample, back);
      for (let i = 0; i < before.length; i++) if (after[i] !== before[i]) differ++;
      expect(differ).toBe(0);
    });
  }

  it("writes a coordinate beyond 1e9 on a channel with a gain as its scale value", () => {
    const sample = gainSample();
    const gate: PolyRectGate = {
      gate_id: "w", name: "W", gate_type: "rectangle", x_channel: "FSC-A", y_channel: "SSC-A",
      vertices: [[-2e9, 1000], [3e9, 1000], [3e9, 120000], [-2e9, 120000]],
      space: "raw", bounds: "closed", color: "#000000", label_offset: null,
    };
    const { xml, back } = roundTrip(sample, gate);
    expect(xml).toContain('gating:min="-400000000"');
    expect(back.gate_type === "rectangle" && back.vertices).toEqual(gate.vertices);
  });
});
