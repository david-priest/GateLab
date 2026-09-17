// The hierarchy CSV and the barcode scheme must round-trip a workspace's MEMBERSHIP, not just
// its text: export and import agreed with each other while both disagreed with the workspace,
// because a gate drawn before the per-gate `space` field existed (no `space`, no `transforms`,
// display coordinates on a CyTOF sample) was written as "raw" and re-imported one arcsinh too low.
import { describe, expect, it } from "vitest";
import { DEFAULT_BARCODE_TEMPLATE, learnBarcodeTemplate } from "./barcodeTemplate";
import { buildBarcodeGating, exportBarcodeScheme, exportHierarchyCsv, parseBarcodeTable, resolveBarcodeScheme } from "./barcodeScheme";
import type { FcsFile } from "./fcs";
import { linkChildToParent, newGateRef, newPopulation, newRootPopulation, type Gate, type PolyRectGate, type PopulationMap } from "./models";
import { applyGatingStrategy } from "./populations";
import { Sample } from "./sample";

/** A deterministic uniform in [0, 1). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const N = 4000;
/** CyTOF channels as the instrument writes them: $PnN carries the mass, $PnS the marker. */
const CHANNELS: { name: string; marker: string | null }[] = [
  { name: "Time", marker: null },
  { name: "Event_length", marker: null },
  { name: "Center", marker: null },
  { name: "Offset", marker: null },
  { name: "Width", marker: null },
  { name: "Residual", marker: null },
  { name: "Amplitude", marker: null },
  { name: "Rh103Di", marker: "103Rh_DNA" },
  { name: "Ce140Di", marker: "140Ce_Beads" },
  { name: "Pt194Di", marker: "194Pt_CD45" },
  { name: "Pt195Di", marker: "195Pt_CD45" },
  { name: "Pt198Di", marker: "198Pt_Live" },
];

/** Four barcode states over 194Pt x 195Pt, a tenth of the events dead, the QC channels spread across the built-in gates. */
function cytofFile(): FcsFile {
  const rand = lcg(7);
  const columns = CHANNELS.map(() => new Float32Array(N));
  const col = (name: string) => columns[CHANNELS.findIndex((c) => c.name === name)];
  for (let i = 0; i < N; i++) {
    const code = i % 4;
    col("Time")[i] = i;
    col("Event_length")[i] = 10 + Math.floor(rand() * 60);
    col("Center")[i] = 250 + rand() * 450;
    col("Offset")[i] = -2 + rand() * 20;
    col("Width")[i] = 50 + rand() * 900;
    col("Residual")[i] = rand() * 250;
    col("Amplitude")[i] = rand() * 2000;
    col("Rh103Di")[i] = 200 + rand() * 3000;
    col("Ce140Di")[i] = rand() * 20;
    col("Pt194Di")[i] = code & 1 ? 300 + rand() * 700 : rand() * 2;
    col("Pt195Di")[i] = code & 2 ? 300 + rand() * 700 : rand() * 2;
    col("Pt198Di")[i] = i % 10 === 0 ? 150 + rand() * 200 : rand() * 30;
  }
  return {
    version: "FCS3.0",
    nEvents: N,
    instrument: "cytof",
    keywords: {},
    spillover: null,
    channels: CHANNELS.map((c, index) => ({ index, name: c.name, marker: c.marker, bits: 32, range: 65536 })),
    columns,
  };
}

const gate = (fields: Omit<PolyRectGate, "color" | "label_offset">): PolyRectGate => ({ ...fields, color: "#000000", label_offset: null });

/** Every population's mask by name; the counts are written into a copy so the input stays as drawn. */
function membership(gates: Gate[], populations: PopulationMap, root: string, sample: Sample): Record<string, Uint8Array> {
  const copy = structuredClone(populations);
  const { masks } = applyGatingStrategy(Object.fromEntries(gates.map((g) => [g.gate_id, g])), copy, root, sample.gateAssayData());
  return Object.fromEntries(Object.values(copy).map((p) => [p.name, masks[p.population_id]]));
}
const count = (mask: Uint8Array): number => mask.reduce((s, v) => s + v, 0);
function expectSameMembership(before: Record<string, Uint8Array>, after: Record<string, Uint8Array>, names: string[]) {
  for (const name of names) {
    expect(after[name], name).toBeDefined();
    const n = count(before[name]);
    expect(n, `${name} holds a proper subset`).toBeGreaterThan(0);
    expect(n, `${name} holds a proper subset`).toBeLessThan(N);
    expect(count(after[name]), `${name} count`).toBe(n);
    expect(before[name].every((v, i) => v === after[name][i]), `${name} events`).toBe(true);
  }
}

/** A workspace mixing the gate records GateLab has stored over time, on a CyTOF sample. */
function mixedWorkspace(sample: Sample) {
  const disp = (channel: string, raw: number) => sample.rawToDisplay(channel, raw);
  const gates: PolyRectGate[] = [
    // Drawn before the per-gate fields existed: neither `space` nor `transforms`, coordinates in
    // the display the sample shows, which is how evaluation reads them (Sample.gateToRaw).
    gate({ gate_id: "g-amp", name: "Amp", gate_type: "rectangle", x_channel: "Time", y_channel: "Amplitude",
      vertices: [[disp("Time", 100), disp("Amplitude", 20)], [disp("Time", 3500), disp("Amplitude", 1200)]] }),
    gate({ gate_id: "g-dna", name: "DNA+", gate_type: "polygon", x_channel: "103Rh_DNA", y_channel: "140Ce_Beads",
      vertices: [[disp("103Rh_DNA", 300), -0.5], [disp("103Rh_DNA", 2500), -0.5], [disp("103Rh_DNA", 2500), disp("140Ce_Beads", 8)], [disp("103Rh_DNA", 300), disp("140Ce_Beads", 8)]] }),
    // Drawn since: display space with the transforms recorded.
    gate({ gate_id: "g-pt", name: "194Pt+", gate_type: "rectangle", x_channel: "194Pt_CD45", y_channel: "195Pt_CD45",
      vertices: [[3, -0.6], [8, 8.5]], space: "display",
      transforms: { "194Pt_CD45": { kind: "asinh", cofactor: 5 }, "195Pt_CD45": { kind: "asinh", cofactor: 5 } } }),
    // Raw, as the built-in QC chain draws its Time rectangles.
    gate({ gate_id: "g-live", name: "Live", gate_type: "rectangle", x_channel: "Time", y_channel: "198Pt_Live", vertices: [[0, -1], [N, 100]], space: "raw" }),
  ];
  const root = newRootPopulation(N);
  const cells = newPopulation("Cells", [newGateRef("g-amp"), newGateRef("g-dna")], root.population_id);
  const alive = newPopulation("Alive", [newGateRef("g-live")], cells.population_id);
  const pos = newPopulation("194Pt+", [newGateRef("g-pt")], alive.population_id);
  const neg = newPopulation("194Pt-", [newGateRef("g-pt", false)], alive.population_id);
  const populations: PopulationMap = Object.fromEntries([root, cells, alive, pos, neg].map((p) => [p.population_id, p]));
  for (const p of [cells, alive, pos, neg]) linkChildToParent(populations, p.population_id, p.parent_id!);
  return { gates, populations, root: root.population_id, names: ["Cells", "Alive", "194Pt+", "194Pt-"] };
}

const bareTemplate = () => ({
  ...DEFAULT_BARCODE_TEMPLATE,
  qc: [],
  states: { "--": [[0, 0], [1, 0], [1, 1]], "+-": [[0, 0], [1, 0], [1, 1]], "-+": [[0, 0], [1, 0], [1, 1]], "++": [[0, 0], [1, 0], [1, 1]] },
} as typeof DEFAULT_BARCODE_TEMPLATE);

describe("hierarchy CSV membership round trip", () => {
  const sample = new Sample(cytofFile());
  it("reads Time linearly and a mass channel on arcsinh, the display these gates were drawn in", () => {
    expect(sample.gatingSpace).toBe("display");
    expect(sample.transformSpec("Time")).toEqual({ kind: "identity" });
    expect(sample.transformSpec("Amplitude")).toEqual({ kind: "asinh", cofactor: 5 });
  });

  it("writes every gate in the space evaluation reads it in, and the re-import keeps every event", () => {
    const ws = mixedWorkspace(sample);
    const before = membership(ws.gates, ws.populations, ws.root, sample);
    const out = exportHierarchyCsv(ws.gates, ws.populations, ws.root, "test", { context: sample, cofactor: sample.arcsinhCofactor });
    expect(out.notes).toEqual([]);
    const lines = out.csv.split("\n");
    const line = (name: string) => lines.find((l) => l.startsWith(`# gate: ${name} |`))!;
    // The legacy gates: display coordinates, so the scale must say so, per axis.
    expect(line("Amp")).toMatch(/^# gate: Amp \| rectangle \| Time x Amplitude \| linear, asinh\(5\) \| x 100\.\.3500 \| y 2\.09\d+\.\.6\.17\d+$/);
    expect(line("DNA+")).toMatch(/^# gate: DNA\+ \| polygon \| 103Rh x 140Ce \| asinh\(5\) \| \(4\.\d+,-0\.5\)/);
    expect(line("194Pt+")).toBe("# gate: 194Pt+ | rectangle | 194Pt x 195Pt | asinh(5) | x 3..8 | y -0.6..8.5");
    expect(line("Live")).toBe(`# gate: Live | rectangle | Time x 198Pt | raw | x 0..${N} | y -1..100`);

    const again = resolveBarcodeScheme(parseBarcodeTable(out.csv), sample.channels);
    expect(again.problems).toEqual([]);
    const rebuilt = buildBarcodeGating(again, bareTemplate(), sample.arcsinhCofactor, { qc: true, channels: sample.channels });
    expect(rebuilt.qc.skipped).toEqual([]);
    const after = membership(Object.values(rebuilt.gates), rebuilt.populations, rebuilt.root_population_id, sample);
    expectSameMembership(before, after, ws.names);
  });

  it("rescales a file written at one cofactor onto a sample displayed at another", () => {
    const ws = mixedWorkspace(sample);
    const before = membership(ws.gates, ws.populations, ws.root, sample);
    const out = exportHierarchyCsv(ws.gates, ws.populations, ws.root, "test", { context: sample, cofactor: sample.arcsinhCofactor });
    const ten = new Sample(cytofFile(), { cytofCofactor: 10 });
    expect(ten.transformSpec("Amplitude")).toEqual({ kind: "asinh", cofactor: 10 });
    const again = resolveBarcodeScheme(parseBarcodeTable(out.csv), ten.channels);
    expect(again.problems).toEqual([]);
    const rebuilt = buildBarcodeGating(again, bareTemplate(), ten.arcsinhCofactor, { qc: true, channels: ten.channels });
    const amp = Object.values(rebuilt.gates).find((g) => g.name === "Amp") as PolyRectGate;
    expect(amp.transforms).toEqual({ Time: { kind: "identity" }, Amplitude: { kind: "asinh", cofactor: 10 } });
    // The same raw value: asinh(20/5) written, asinh(20/10) read.
    expect(Math.min(...amp.vertices.map((v) => v[1]))).toBeCloseTo(Math.asinh(20 / 10), 5);
    const after = membership(Object.values(rebuilt.gates), rebuilt.populations, rebuilt.root_population_id, ten);
    expectSameMembership(before, after, ws.names);
  });

  it("parses the plain scale words as before, the sample's cofactor assumed", () => {
    const csv = "# gate: A | rectangle | Time x Amplitude | linear, asinh | x 0..100 | y 1..6\n# gate: B | polygon | 103Rh x 140Ce | arcsinh (5) | (4,-0.5) (7,-0.5) (7,2)\n# population: P = A, B\n";
    const s = resolveBarcodeScheme(parseBarcodeTable(csv), sample.channels);
    expect(s.problems).toEqual([]);
    expect(s.gateDeclarations.map((g) => [g.name, g.transforms, g.cofactors])).toEqual([
      ["A", { x: "identity", y: "asinh" }, undefined],
      ["B", { x: "asinh", y: "asinh" }, { x: 5, y: 5 }],
    ]);
  });
});

describe("barcode scheme membership round trip", () => {
  const sample = new Sample(cytofFile());
  const ranges = { Time: [0, N] as [number, number] };
  const TABLE = ["# plane: 194Pt x 195Pt", "name,194Pt,195Pt", "S00,0,0", "S10,1,0", "S01,0,1", "S11,1,1"].join("\n");

  it("exports a debarcoding workspace whose QC gates predate the space field, and the re-import keeps every event", () => {
    const scheme = resolveBarcodeScheme(parseBarcodeTable(TABLE), sample.channels);
    expect(scheme.problems).toEqual([]);
    const built = buildBarcodeGating(scheme, DEFAULT_BARCODE_TEMPLATE, sample.arcsinhCofactor, { qc: true, channels: sample.channels, ranges });
    const gates = Object.values(built.gates) as PolyRectGate[];
    const names = ["Cells", "Live", "S00", "S10", "S01", "S11"];
    const asBuilt = membership(gates, built.populations, built.root_population_id, sample);

    // The QC chain as an older workspace stored it: the display gates without their fields, and
    // AmplitudeGate moved into display coordinates by hand, as the bug report's workspace had it.
    for (const g of gates) {
      if (["SingletsGate", "DNA+Bead-Gate", "Live"].includes(g.name)) {
        delete g.space;
        delete g.transforms;
      }
      if (g.name === "AmplitudeGate") {
        g.vertices = g.vertices.map(([x, y]) => [x, sample.rawToDisplay("Amplitude", y)]);
        delete g.space;
      }
    }
    const before = membership(gates, built.populations, built.root_population_id, sample);
    expectSameMembership(asBuilt, before, names); // the legacy records evaluate exactly as the modern ones

    const learned = learnBarcodeTemplate(gates, sample.arcsinhCofactor, "test", built.populations, built.root_population_id, sample)!;
    expect(learned.notes).toEqual([]);
    const out = exportBarcodeScheme(gates, built.populations, built.root_population_id, learned, built.populationMetadata, "test", sample);
    const lines = out.csv.split("\n");
    const line = (name: string) => lines.find((l) => l.startsWith(`# gate: ${name} |`))!;
    expect(line("AmplitudeGate")).toMatch(/^# gate: AmplitudeGate \| rectangle \| Time x Amplitude \| linear, asinh\(5\) \| x full \| y 1\.\d+\.\.6\.\d+$/);
    expect(line("CenterGate")).toBe("# gate: CenterGate | rectangle | Time x Center | raw | x full | y 321.283..615.828");
    expect(line("SingletsGate")).toBe("# gate: SingletsGate | rectangle | Event_length x 103Rh | linear, asinh(5) | x -3.458..55.468 | y 1.043..8.508");
    expect(line("DNA+Bead-Gate")).toMatch(/^# gate: DNA\+Bead-Gate \| polygon \| 140Ce x 103Rh \| asinh\(5\) \| /);
    expect(line("Live")).toMatch(/^# gate: Live \| polygon \| 103Rh x 198Pt \| asinh\(5\) \| /);
    const barcodeLines = lines.filter((l) => /^# gate: 19[45][+-]19[45][+-] \|/.test(l));
    expect(barcodeLines).toHaveLength(4);
    for (const l of barcodeLines) expect(l).toMatch(/\| polygon \| 19[45]Pt x 19[45]Pt \| asinh\(5\) \| /);

    const again = resolveBarcodeScheme(parseBarcodeTable(out.csv), sample.channels);
    expect(again.problems).toEqual([]);
    const rebuilt = buildBarcodeGating(again, bareTemplate(), sample.arcsinhCofactor, { qc: true, channels: sample.channels, ranges });
    expect(rebuilt.qc.skipped).toEqual([]);
    const after = membership(Object.values(rebuilt.gates), rebuilt.populations, rebuilt.root_population_id, sample);
    expectSameMembership(before, after, names);
  });
});
