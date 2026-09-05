import { describe, expect, it } from "vitest";
import { isDnaChannel, massLabel, massToken } from "./barcodeMass";
import {
  DEFAULT_BARCODE_TEMPLATE,
  learnBarcodeTemplate,
  templateShapesFor,
  type BarcodeTemplate,
} from "./barcodeTemplate";
import {
  barcodeSchemeTemplateCsv,
  buildBarcodeGating,
  effectiveQcChain,
  exportBarcodeScheme,
  exportHierarchyCsv,
  parseBarcodeString,
  parseBarcodeTable,
  previewQcChain,
  proposePlanes,
  resolveBarcodeScheme,
  resolveMassToken,
  resolveQcChannel,
  type BarcodeChannelLike,
} from "./barcodeScheme";
import { newGateRef, newPopulation, newRootPopulation, type PolyRectGate, type PopulationMap } from "./models";

/** A CyTOF XT channel list as the nPhos4 files carry it. */
const QC_CHANNELS: BarcodeChannelLike[] = [
  { key: "Time", pnn: "Time", marker: null },
  { key: "Event_length", pnn: "Event_length", marker: null },
  { key: "Center", pnn: "Center", marker: null },
  { key: "Offset", pnn: "Offset", marker: null },
  { key: "Width", pnn: "Width", marker: null },
  { key: "Residual", pnn: "Residual", marker: null },
  { key: "Amplitude", pnn: "Amplitude", marker: null },
  { key: "103Rh_DNA", pnn: "Rh103Di", marker: "103Rh_DNA" },
  { key: "140Ce_H3K27me3", pnn: "Ce140Di", marker: "140Ce_H3K27me3" },
  { key: "198Pt_Live", pnn: "Pt198Di", marker: "198Pt_Live" },
];

const CHANNELS: BarcodeChannelLike[] = [
  { key: "Time", pnn: "Time", marker: null },
  { key: "103Rh_DNA", pnn: "103Rh_DNA", marker: "103Rh_DNA" },
  { key: "89Y_CD45", pnn: "89Y_CD45", marker: "89Y_CD45" },
  { key: "113In_CD45", pnn: "113In_CD45", marker: "113In_CD45" },
  { key: "115In_CD45", pnn: "115In_CD45", marker: "115In_CD45" },
  { key: "194Pt_CD45", pnn: "194Pt_CD45", marker: "194Pt_CD45" },
  { key: "195Pt_CD45", pnn: "195Pt_CD45", marker: "195Pt_CD45" },
  { key: "196Pt_CD45", pnn: "196Pt_CD45", marker: "196Pt_CD45" },
  { key: "CD45", pnn: "Pt198Di", marker: "198Pt_Live" },
];

describe("mass tokens", () => {
  it("reads the isotope out of every channel naming style", () => {
    expect(massToken("194Pt_CD45")).toEqual({ mass: 194, element: "Pt" });
    expect(massToken("Pt194Di")).toEqual({ mass: 194, element: "Pt" });
    expect(massToken("89Y CD45")).toEqual({ mass: 89, element: "Y" });
    expect(massToken("89")).toEqual({ mass: 89, element: null });
    expect(massToken("CD45")).toBeNull();
    expect(massToken("Time")).toBeNull();
    expect(massLabel("Pt194Di")).toBe("194Pt");
  });

  it("knows the intercalator channels", () => {
    expect(isDnaChannel("103Rh_DNA")).toBe(true);
    expect(isDnaChannel("Ir191Di")).toBe(true);
    expect(isDnaChannel("194Pt_CD45")).toBe(false);
  });

  it("resolves a scheme token to one channel, or reports the candidates", () => {
    expect(resolveMassToken("194", CHANNELS)).toEqual({ key: "194Pt_CD45" });
    expect(resolveMassToken("194Pt", CHANNELS)).toEqual({ key: "194Pt_CD45" });
    expect(resolveMassToken("198Pt", CHANNELS)).toEqual({ key: "CD45" });
    expect(resolveMassToken("CD45", CHANNELS)).toEqual({ key: "CD45" });
    expect(resolveMassToken("140", CHANNELS)).toEqual({ candidates: [] });
  });
});

const TABLE = [
  "# plane: 195Pt x 194Pt",
  "# plane: 115In x 113In",
  "# plane: 103Rh(display) x 89Y",
  "name,file_name,condition,89Y,113In,115In,194Pt,195Pt",
  "01,ex1_01.fcs,DMSO,1,1,0,0,0",
  "02,ex1_02.fcs,DMSO,1,0,1,0,0",
  "03,ex1_03.fcs,Spike,0,1,0,1,0",
].join("\n");

describe("barcode table parsing", () => {
  it("reads header declarations, the header row and the rows", () => {
    const t = parseBarcodeTable(TABLE);
    expect(t.problems).toEqual([]);
    expect(t.headers).toEqual(["name", "file_name", "condition", "89Y", "113In", "115In", "194Pt", "195Pt"]);
    expect(t.rows).toHaveLength(3);
    expect(t.planeDeclarations.map((d) => [d.x, d.y, d.xDisplay, d.yDisplay])).toEqual([
      ["195Pt", "194Pt", false, false],
      ["115In", "113In", false, false],
      ["103Rh", "89Y", true, false],
    ]);
  });

  it("accepts tab-separated input and quoted commas", () => {
    const t = parseBarcodeTable("name\tcondition\t89Y\n\"a, b\"\tDMSO\t1\n");
    expect(t.delimiter).toBe("\t");
    expect(t.rows[0][0]).toBe("a, b");
  });

  it("reports a ragged row and a bad declaration without giving up", () => {
    const t = parseBarcodeTable("# plane: 195Pt\nname,89Y\n01,1\n02\n");
    expect(t.problems.some((p) => p.includes("plane declaration"))).toBe(true);
    expect(t.problems.some((p) => p.includes("Line 4"))).toBe(true);
    expect(t.rows).toHaveLength(1);
  });

  it("expands the string form of a barcode", () => {
    expect(parseBarcodeString("89+196-113+115-194-195-")).toEqual([
      { token: "89", state: true }, { token: "196", state: false }, { token: "113", state: true },
      { token: "115", state: false }, { token: "194", state: false }, { token: "195", state: false },
    ]);
    expect(parseBarcodeString("89Y+ 196Pt-")).toHaveLength(2);
    expect(parseBarcodeString("hello")).toBeNull();
  });
});

describe("resolving a scheme against the loaded channels", () => {
  it("classifies columns, keeps metadata, and honours the declared planes", () => {
    const s = resolveBarcodeScheme(parseBarcodeTable(TABLE), CHANNELS);
    expect(s.problems).toEqual([]);
    expect(s.channels).toEqual(["89Y_CD45", "113In_CD45", "115In_CD45", "194Pt_CD45", "195Pt_CD45"]);
    expect(s.planes).toEqual([
      { x: "195Pt_CD45", y: "194Pt_CD45", xIsBarcode: true, yIsBarcode: true },
      { x: "115In_CD45", y: "113In_CD45", xIsBarcode: true, yIsBarcode: true },
      { x: "103Rh_DNA", y: "89Y_CD45", xIsBarcode: false, yIsBarcode: true },
    ]);
    expect(s.samples[0]).toMatchObject({ name: "01", fileName: "ex1_01.fcs", metadata: { condition: "DMSO" } });
    expect(s.samples[0].states).toEqual({ "89Y_CD45": true, "113In_CD45": true, "115In_CD45": false, "194Pt_CD45": false, "195Pt_CD45": false });
    expect(s.metadataColumns).toEqual(["condition"]);
  });

  it("proposes planes from column order and draws an odd channel against DNA", () => {
    const text = "name,89Y,113In,115In,194Pt,195Pt\n01,1,1,0,0,0\n02,0,0,1,0,1\n";
    const s = resolveBarcodeScheme(parseBarcodeTable(text), CHANNELS);
    expect(s.problems).toEqual([]);
    expect(s.planes).toEqual([
      { x: "113In_CD45", y: "89Y_CD45", xIsBarcode: true, yIsBarcode: true },
      { x: "194Pt_CD45", y: "115In_CD45", xIsBarcode: true, yIsBarcode: true },
      { x: "103Rh_DNA", y: "195Pt_CD45", xIsBarcode: false, yIsBarcode: true },
    ]);
    expect(s.notes[0]).toContain("103Rh_DNA");
  });

  it("accepts the string form, and names populations from sample_id when no name column exists", () => {
    const text = "sample_id,file_name,Barcode\n7,ex1_07.fcs,89-196-113+115-194-195-\n8,ex1_08.fcs,89-196-113-115-194-195+\n";
    const s = resolveBarcodeScheme(parseBarcodeTable(text), CHANNELS);
    expect(s.problems).toEqual([]);
    expect(s.channels).toEqual(["89Y_CD45", "196Pt_CD45", "113In_CD45", "115In_CD45", "194Pt_CD45", "195Pt_CD45"]);
    expect(s.samples.map((x) => x.name)).toEqual(["7", "8"]);
    expect(s.samples[1].states["195Pt_CD45"]).toBe(true);
    expect(s.planes).toHaveLength(3);
    expect(s.metadataColumns).toEqual(["sample_id", "Barcode"]);
  });

  it("refuses blanks, duplicate combinations, unresolved tokens and display axes with states", () => {
    const blank = resolveBarcodeScheme(parseBarcodeTable("name,89Y,196Pt\n01,1,\n02,0,1\n"), CHANNELS);
    expect(blank.problems.some((p) => p.includes("blank is not a zero"))).toBe(true);
    const dup = resolveBarcodeScheme(parseBarcodeTable("name,89Y,196Pt\n01,1,0\n02,1,0\n"), CHANNELS);
    expect(dup.problems.some((p) => p.includes("share the same barcode combination"))).toBe(true);
    const bad = resolveBarcodeScheme(parseBarcodeTable("name,89Y,196Pt\n01,1,x\n02,0,1\n"), CHANNELS);
    expect(bad.problems.some((p) => p.includes("other than a state"))).toBe(true);
    const disp = resolveBarcodeScheme(parseBarcodeTable("# plane: 196Pt(display) x 89Y\nname,89Y,196Pt\n01,1,0\n02,0,1\n"), CHANNELS);
    expect(disp.problems.some((p) => p.includes("display-only"))).toBe(true);
  });

  it("validates an edited plane layout the same way", () => {
    const s = resolveBarcodeScheme(parseBarcodeTable("name,89Y,196Pt\n01,1,0\n02,0,1\n"), CHANNELS, [
      { x: "196Pt_CD45", y: "89Y_CD45", xIsBarcode: true, yIsBarcode: true },
      { x: "103Rh_DNA", y: "89Y_CD45", xIsBarcode: false, yIsBarcode: true },
    ]);
    expect(s.problems.some((p) => p.includes("more than one plane"))).toBe(true);
  });

  it("proposePlanes reports a declared barcode axis with no state column", () => {
    const r = proposePlanes(["89Y_CD45"], CHANNELS, [{ x: "196Pt", y: "89Y", xDisplay: false, yDisplay: false, line: 1 }]);
    expect(r.problems.some((p) => p.includes("no state column"))).toBe(true);
  });
});

describe("building the strategy", () => {
  it("makes four gates per barcode plane, two per display plane, and one AND population per row", () => {
    const s = resolveBarcodeScheme(parseBarcodeTable(TABLE), CHANNELS);
    const r = buildBarcodeGating(s, DEFAULT_BARCODE_TEMPLATE, 5);
    expect(r.nGates).toBe(4 + 4 + 2);
    expect(r.nPopulations).toBe(3);
    const names = Object.values(r.gates).map((g) => g.name).sort();
    expect(names).toEqual(["113+115+", "113+115-", "113-115+", "113-115-", "194+195+", "194+195-", "194-195+", "194-195-", "89+", "89-"].sort());
    for (const g of Object.values(r.gates)) {
      expect(g.space).toBe("display");
      expect(g.transforms).toEqual({ [g.x_channel]: { kind: "asinh", cofactor: 5 }, [g.y_channel]: { kind: "asinh", cofactor: 5 } });
    }
    const pops = Object.values(r.populations).filter((p) => p.population_id !== r.root_population_id);
    expect(pops.map((p) => p.name)).toEqual(["01", "02", "03"]);
    const byId = r.gates;
    const refNames = (name: string) => pops.find((p) => p.name === name)!.gate_refs.map((ref) => byId[ref.gate_id].name).sort();
    // 01: 89+ 113+ 115- 194- 195-  ->  194-195-, 113+115-, 89Y+
    expect(refNames("01")).toEqual(["113+115-", "194-195-", "89+"].sort());
    expect(refNames("03")).toEqual(["113+115-", "194+195-", "89-"].sort());
    expect(pops.every((p) => p.gate_logic === "and" && p.gate_refs.every((ref) => ref.include))).toBe(true);
    expect(r.populationMetadata[pops[0].population_id]).toEqual({ condition: "DMSO", file_name: "ex1_01.fcs" });
    expect(r.metadataColumns).toEqual(["condition", "file_name"]);
  });

  it("draws every barcode gate as a polygon of seven or eight vertices, the display-plane pair split at the boundary", () => {
    const s = resolveBarcodeScheme(parseBarcodeTable(TABLE), CHANNELS);
    const r = buildBarcodeGating(s, DEFAULT_BARCODE_TEMPLATE, 5);
    for (const g of Object.values(r.gates) as PolyRectGate[]) {
      expect(g.gate_type).toBe("polygon");
      expect(g.vertices.length).toBeGreaterThanOrEqual(7);
      expect(g.vertices.length).toBeLessThanOrEqual(8);
    }
    const neg = Object.values(r.gates).find((g) => g.name === "89-") as PolyRectGate;
    const pos = Object.values(r.gates).find((g) => g.name === "89+") as PolyRectGate;
    expect(neg.x_channel).toBe("103Rh_DNA");
    // 89Y is on y: the negative band ends at the boundary and the positive band starts there.
    expect(Math.max(...neg.vertices.map((v) => v[1]))).toBeCloseTo(DEFAULT_BARCODE_TEMPLATE.boundary);
    expect(Math.min(...pos.vertices.map((v) => v[1]))).toBeCloseTo(DEFAULT_BARCODE_TEMPLATE.boundary);
    expect(Math.min(...neg.vertices.map((v) => v[0]))).toBe(DEFAULT_BARCODE_TEMPLATE.displayRange[0]);
    expect(Math.max(...neg.vertices.map((v) => v[0]))).toBe(DEFAULT_BARCODE_TEMPLATE.displayRange[1]);
  });

  it("creates the QC chain above the samples in the form the template draws it, with Time spanning the sample", () => {
    const channels = [...QC_CHANNELS, ...CHANNELS.filter((c) => c.key !== "Time" && c.key !== "103Rh_DNA" && c.key !== "CD45")];
    const s = resolveBarcodeScheme(parseBarcodeTable(TABLE), channels);
    const r = buildBarcodeGating(s, DEFAULT_BARCODE_TEMPLATE, 5, { qc: true, channels, ranges: { Time: [0, 1000] } });
    expect(r.qc.skipped).toEqual([]);
    expect(r.qc.populations.map((p) => `${p.name}:${p.gates.length}`)).toEqual(["Cells:7", "Live:1"]);
    expect(r.nGates).toBe(10 + 8);
    const root = r.populations[r.root_population_id];
    expect(root.children).toHaveLength(1);
    const cells = r.populations[root.children[0]];
    expect(cells.name).toBe("Cells");
    expect(cells.gate_refs).toHaveLength(7);
    const live = r.populations[cells.children[0]];
    expect(live.name).toBe("Live");
    expect(live.children.map((id) => r.populations[id].name)).toEqual(["01", "02", "03"]);
    const gate = (name: string) => Object.values(r.gates).find((g) => g.name === name) as PolyRectGate;
    // Gaussian gates: raw-space rectangles stretched 2% beyond the sample's Time range.
    const center = gate("CenterGate");
    expect(center.gate_type).toBe("rectangle");
    expect(center.space ?? "raw").toBe("raw");
    expect(center.x_channel).toBe("Time");
    expect(Math.min(...center.vertices.map((v) => v[0]))).toBeCloseTo(-20);
    expect(Math.max(...center.vertices.map((v) => v[0]))).toBeCloseTo(1020);
    expect(Math.min(...center.vertices.map((v) => v[1]))).toBeCloseTo(321.283);
    // Singlets: display rectangle, event length untransformed, DNA arcsinh.
    const singlets = gate("SingletsGate");
    expect(singlets.gate_type).toBe("rectangle");
    expect(singlets.transforms).toEqual({ Event_length: { kind: "identity" }, "103Rh_DNA": { kind: "asinh", cofactor: 5 } });
    // DNA+ bead-: polygon on the bead channel against DNA, arcsinh both.
    const bead = gate("DNA+Bead-Gate");
    expect(bead.gate_type).toBe("polygon");
    expect(bead.x_channel).toBe("140Ce_H3K27me3");
    expect(bead.transforms).toEqual({ "140Ce_H3K27me3": { kind: "asinh", cofactor: 5 }, "103Rh_DNA": { kind: "asinh", cofactor: 5 } });
    expect(gate("Live").y_channel).toBe("198Pt_Live");
  });

  it("reuses the workspace's gates of the same name and channels instead of creating them again", () => {
    const channels = [...QC_CHANNELS, ...CHANNELS.filter((c) => c.key !== "Time" && c.key !== "103Rh_DNA" && c.key !== "CD45")];
    const s = resolveBarcodeScheme(parseBarcodeTable(TABLE), channels);
    const first = buildBarcodeGating(s, DEFAULT_BARCODE_TEMPLATE, 5, { qc: true, channels, ranges: { Time: [0, 1000] } });
    // A second layout over the same gates: the 194/195 plane is dropped, so its four gates
    // are not needed, and a new 196Pt channel joins 89Y.
    const other = "# plane: 196Pt x 89Y\n# plane: 115In x 113In\nname,89Y,196Pt,113In,115In\n01,1,0,1,0\n02,0,1,0,1\n";
    const s2 = resolveBarcodeScheme(parseBarcodeTable(other), channels);
    const second = buildBarcodeGating(s2, DEFAULT_BARCODE_TEMPLATE, 5, {
      qc: true, channels, ranges: { Time: [0, 1000] }, existingGates: Object.values(first.gates),
    });
    // All eight QC gates and the four 115In x 113In gates are reused; the 196Pt x 89Y plane is new.
    expect(second.reusedGateIds).toHaveLength(8 + 4);
    expect(second.nGates).toBe(4);
    const firstByName = Object.fromEntries(Object.values(first.gates).map((g) => [g.name, g.gate_id]));
    const cells = Object.values(second.populations).find((p) => p.name === "Cells")!;
    expect(cells.gate_refs.map((r) => r.gate_id)).toContain(firstByName.CenterGate);
    const s01 = Object.values(second.populations).find((p) => p.name === "01")!;
    expect(s01.gate_refs.map((r) => r.gate_id)).toContain(firstByName["113+115-"]);
    expect(Object.keys(second.gates).every((id) => !first.gates[id])).toBe(true);
    // Reuse off: everything is created afresh.
    const fresh = buildBarcodeGating(s2, DEFAULT_BARCODE_TEMPLATE, 5, { qc: true, channels, existingGates: Object.values(first.gates), reuse: false });
    expect(fresh.reusedGateIds).toEqual([]);
    expect(fresh.nGates).toBe(8 + 4 + 4);
  });

  it("skips a QC gate whose channel is absent and says so, and leaves out a population with no gate left", () => {
    const channels = QC_CHANNELS.filter((c) => c.key !== "140Ce_H3K27me3" && c.key !== "198Pt_Live");
    const preview = previewQcChain(DEFAULT_BARCODE_TEMPLATE.qc, channels);
    expect(preview.populations.map((p) => `${p.name}:${p.gates.length}`)).toEqual(["Cells:6"]);
    expect(preview.skipped).toEqual([
      "Cells / DNA+Bead-Gate: no channel matches 140Ce.",
      "Live / Live: no channel matches Live.",
      "Live: none of its gates could be placed, so the population is left out.",
    ]);
    const s = resolveBarcodeScheme(parseBarcodeTable("name,194Pt,195Pt\n01,1,0\n02,0,1\n"), CHANNELS);
    const r = buildBarcodeGating(s, DEFAULT_BARCODE_TEMPLATE, 5, { qc: true, channels });
    expect(r.qc).toEqual(preview);
    const root = r.populations[r.root_population_id];
    const cells = r.populations[root.children[0]];
    expect(cells.name).toBe("Cells");
    expect(cells.children.map((id) => r.populations[id].name)).toEqual(["01", "02"]);
  });

  it("resolves QC channels by name, by role and by isotope", () => {
    const channels: BarcodeChannelLike[] = [
      { key: "Time", pnn: "Time", marker: null },
      { key: "Event length", pnn: "Event_length", marker: null },
      { key: "Ir191Di", pnn: "Ir191Di", marker: "191Ir_DNA1" },
      { key: "Ce140Di", pnn: "Ce140Di", marker: "140Ce_Beads" },
      { key: "Pt195Di", pnn: "Pt195Di", marker: "195Pt_cisplatin" },
    ];
    expect(resolveQcChannel("Time", channels)).toBe("Time");
    expect(resolveQcChannel("Event_length", channels)).toBe("Event length");
    expect(resolveQcChannel("DNA", channels)).toBe("Ir191Di");
    expect(resolveQcChannel("103Rh_DNA", channels)).toBe("Ir191Di");
    expect(resolveQcChannel("140Ce", channels)).toBe("Ce140Di");
    expect(resolveQcChannel("Live", channels)).toBe("Pt195Di");
    expect(resolveQcChannel("Center", channels)).toBeNull();
  });

  it("refuses to build from a scheme with problems", () => {
    const s = resolveBarcodeScheme(parseBarcodeTable("name,89Y,196Pt\n01,1,0\n02,1,0\n"), CHANNELS);
    expect(() => buildBarcodeGating(s, DEFAULT_BARCODE_TEMPLATE, 5)).toThrow("problem");
  });

  it("ships a template CSV that the parser accepts", () => {
    const s = resolveBarcodeScheme(parseBarcodeTable(barcodeSchemeTemplateCsv()), CHANNELS);
    expect(s.problems).toEqual([]);
    expect(s.planes).toHaveLength(3);
  });
});

function planeGates(x: string, y: string, shapes: Record<string, [number, number][]>, raw = false): PolyRectGate[] {
  return Object.entries(shapes).map(([name, vertices], i) => ({
    gate_id: `${x}-${y}-${i}`,
    name,
    gate_type: "polygon",
    x_channel: x,
    y_channel: y,
    vertices: raw ? vertices.map(([a, b]) => [5 * Math.sinh(a), 5 * Math.sinh(b)] as [number, number]) : vertices,
    color: "#000",
    label_offset: null,
    ...(raw ? {} : { space: "display" as const }),
  }));
}

describe("templates", () => {
  it("the default has a polygon of seven or eight vertices per state and serves either orientation", () => {
    for (const k of ["--", "+-", "-+", "++"] as const) {
      expect(DEFAULT_BARCODE_TEMPLATE.states[k].length).toBeGreaterThanOrEqual(7);
      expect(DEFAULT_BARCODE_TEMPLATE.states[k].length).toBeLessThanOrEqual(8);
    }
    const t: BarcodeTemplate = {
      ...DEFAULT_BARCODE_TEMPLATE,
      planes: { "195Ptx194Pt": { states: { "--": [[0, 0], [1, 0], [1, 1]], "+-": [[2, 0], [3, 0], [3, 1]], "-+": [[0, 2], [1, 2], [1, 3]], "++": [[2, 2], [3, 2], [3, 3]] } } },
    };
    expect(templateShapesFor(t, "195Pt", "194Pt")["+-"]).toEqual([[2, 0], [3, 0], [3, 1]]);
    // Reversed orientation swaps coordinates and the mixed states: x+ y- in (194Pt, 195Pt) is
    // the stored plane's x- y+, with each vertex's coordinates swapped.
    expect(templateShapesFor(t, "194Pt", "195Pt")["+-"]).toEqual([[2, 0], [2, 1], [3, 1]]);
    expect(templateShapesFor(t, "89Y", "196Pt")).toBe(DEFAULT_BARCODE_TEMPLATE.states);
  });

  it("learns per-plane shapes from a workspace and classifies states by centroid", () => {
    const gates = [
      ...planeGates("195Pt_CD45", "194Pt_CD45", DEFAULT_BARCODE_TEMPLATE.states),
      // The same plane drawn in raw space is converted with the cofactor.
      ...planeGates("115In_CD45", "113In_CD45", DEFAULT_BARCODE_TEMPLATE.states, true),
      // Not a plane: three gates only.
      ...planeGates("116Cd_CD19", "198Pt_Live", { a: [[0, 0], [1, 0], [1, 1]], b: [[2, 0], [3, 0], [3, 1]], c: [[0, 2], [1, 2], [1, 3]] }),
    ];
    const learned = learnBarcodeTemplate(gates, 5)!;
    expect(learned).not.toBeNull();
    expect(learned.planes.map((p) => `${p.xLabel}x${p.yLabel}`).sort()).toEqual(["115Inx113In", "195Ptx194Pt"]);
    expect(learned.planes[0].gateNames["++"]).toBe("++");
    expect(learned.template.planes["195Ptx194Pt"].states["--"]).toEqual(DEFAULT_BARCODE_TEMPLATE.states["--"]);
    const rawPlane = learned.template.planes["115Inx113In"].states["++"];
    rawPlane.forEach((v, i) => {
      expect(v[0]).toBeCloseTo(DEFAULT_BARCODE_TEMPLATE.states["++"][i][0], 9);
    });
    // Mean of the "--" box's far edges and the "+-"/"-+" near edges: (1.5 + 1.8 + 1.55 + 1.8) / 4.
    expect(learned.template.boundary).toBeCloseTo(1.66, 2);
  });

  it("writes the scheme table back out of a workspace so that it imports to the same strategy", () => {
    const channels = [...QC_CHANNELS, ...CHANNELS.filter((c) => c.key !== "Time" && c.key !== "103Rh_DNA" && c.key !== "CD45")];
    const built = buildBarcodeGating(resolveBarcodeScheme(parseBarcodeTable(TABLE), channels), DEFAULT_BARCODE_TEMPLATE, 5, { qc: true, channels, ranges: { Time: [0, 1000] } });
    const gates = Object.values(built.gates);
    const learned = learnBarcodeTemplate(gates, 5, "test", built.populations, built.root_population_id)!;
    expect(learned.qcNames).toEqual(["Cells", "Live"]);
    const out = exportBarcodeScheme(gates, built.populations, built.root_population_id, learned, built.populationMetadata, "test");
    expect(out.nSamples).toBe(3);
    expect(out.notes).toEqual([]);
    // Planes by lightest isotope: the display plane on 89Y, then 113/115, then 194/195.
    expect(out.planeLabels).toEqual(["103Rh(display) x 89Y", "115Inx113In".replace("x", " x "), "195Pt x 194Pt"]);
    expect(out.channels).toEqual(["89Y_CD45", "113In_CD45", "115In_CD45", "194Pt_CD45", "195Pt_CD45"]);
    const lines = out.csv.trim().split("\n");
    expect(lines[0]).toMatch(/^# GateLab barcode scheme, saved \d{4}-\d{2}-\d{2} from test\.$/);
    expect(lines.filter((l) => l.startsWith("# plane:"))).toEqual(["# plane: 103Rh(display) x 89Y", "# plane: 115In x 113In", "# plane: 195Pt x 194Pt"]);
    const headerIdx = lines.findIndex((l) => l.startsWith("name,"));
    expect(lines[headerIdx]).toBe("name,file_name,condition,89Y,113In,115In,194Pt,195Pt");
    expect(lines[headerIdx + 1]).toBe("01,ex1_01.fcs,DMSO,1,1,0,0,0");
    // Round trip: the written table resolves to the same samples and states.
    const again = resolveBarcodeScheme(parseBarcodeTable(out.csv), channels);
    expect(again.problems).toEqual([]);
    const before = resolveBarcodeScheme(parseBarcodeTable(TABLE), channels);
    const essence = (s: { name: string; fileName: string | null; states: Record<string, boolean>; metadata: Record<string, string> }) =>
      [s.name, s.fileName, s.states, s.metadata];
    expect(again.samples.map(essence)).toEqual(before.samples.map(essence));
    expect(again.planes.map((p) => `${p.x}|${p.y}|${p.xIsBarcode}|${p.yIsBarcode}`).sort()).toEqual(
      before.planes.map((p) => `${p.x}|${p.y}|${p.xIsBarcode}|${p.yIsBarcode}`).sort(),
    );
    expect(again.metadataColumns).toEqual(before.metadataColumns);
  });

  it("leaves out a population that uses some but not all planes, and says so", () => {
    const built = buildBarcodeGating(resolveBarcodeScheme(parseBarcodeTable(TABLE), CHANNELS), DEFAULT_BARCODE_TEMPLATE, 5);
    const gates = Object.values(built.gates);
    const first = Object.values(built.populations).find((p) => p.name === "01")!;
    const partial = newPopulation("half", first.gate_refs.slice(0, 1), built.root_population_id, "and");
    built.populations[partial.population_id] = partial;
    built.populations[built.root_population_id].children.push(partial.population_id);
    const learned = learnBarcodeTemplate(gates, 5, "test", built.populations, built.root_population_id)!;
    const out = exportBarcodeScheme(gates, built.populations, built.root_population_id, learned);
    expect(out.nSamples).toBe(3);
    expect(out.notes).toEqual(["Left out 1 population(s) that use some but not all planes: half."]);
  });

  it("returns null when no plane has four gates", () => {
    expect(learnBarcodeTemplate(planeGates("a", "b", { only: [[0, 0], [1, 0], [1, 1]] }), 5)).toBeNull();
  });

  it("captures the QC chain above the sample populations as drawn", () => {
    const plane = planeGates("195Pt_CD45", "194Pt_CD45", DEFAULT_BARCODE_TEMPLATE.states);
    const center: PolyRectGate = {
      gate_id: "center", name: "CenterGate", gate_type: "rectangle", x_channel: "Time", y_channel: "Center",
      vertices: [[0, 321.283], [9e6, 615.828]], color: "#000", label_offset: null,
    };
    const singlets: PolyRectGate = {
      gate_id: "singlets", name: "SingletsGate", gate_type: "rectangle", x_channel: "Event_length", y_channel: "103Rh_DNA",
      vertices: [[-3.458, 1.043], [55.468, 1.043], [55.468, 8.508], [-3.458, 8.508]], color: "#000", label_offset: null,
      space: "display", transforms: { Event_length: { kind: "identity" }, "103Rh_DNA": { kind: "asinh", cofactor: 5 } },
    };
    const cd19: PolyRectGate = {
      gate_id: "cd19", name: "CD19+198-", gate_type: "polygon", x_channel: "116Cd_CD19", y_channel: "198Pt_Live",
      vertices: [[0.178, 0.512], [0.624, 1.167], [2.039, 2.203], [3.728, 2.99], [6.229, 2.74], [7.458, 1.251], [7.435, -0.342], [0.103, -0.298]],
      color: "#000", label_offset: null, space: "display",
      transforms: { "116Cd_CD19": { kind: "asinh", cofactor: 5 }, "198Pt_Live": { kind: "asinh", cofactor: 5 } },
    };
    const root = newRootPopulation();
    const cells = newPopulation("CellsB 1nolive", [newGateRef("center", true), newGateRef("singlets", true)], root.population_id, "and");
    const cellsB = newPopulation("CellsB", [newGateRef("cd19", true)], cells.population_id, "and");
    const s1 = newPopulation("01", [newGateRef(plane[0].gate_id, true)], cellsB.population_id, "and");
    const s2 = newPopulation("02", [newGateRef(plane[1].gate_id, true)], cellsB.population_id, "and");
    root.children.push(cells.population_id);
    cells.children.push(cellsB.population_id);
    cellsB.children.push(s1.population_id, s2.population_id);
    const populations: PopulationMap = Object.fromEntries([root, cells, cellsB, s1, s2].map((p) => [p.population_id, p]));
    const learned = learnBarcodeTemplate([...plane, center, singlets, cd19], 5, "test", populations, root.population_id)!;
    expect(learned.qcNames).toEqual(["CellsB 1nolive", "CellsB"]);
    expect(learned.notes).toEqual([]);
    const [q1, q2] = learned.template.qc;
    expect(q1.gates.map((g) => `${g.name}:${g.gate_type}:${g.space}`)).toEqual(["CenterGate:rectangle:raw", "SingletsGate:rectangle:display"]);
    // A two-corner rectangle is stored as four corners; a Time-axis rectangle is marked to span the sample.
    expect(q1.gates[0].vertices).toEqual([[0, 321.283], [9e6, 321.283], [9e6, 615.828], [0, 615.828]]);
    expect(q1.gates[0].xFull).toBe(true);
    expect(q1.gates[1].transforms).toEqual({ x: "identity", y: "asinh" });
    expect(q1.gates[1].xFull).toBeUndefined();
    expect(q2.gates[0]).toMatchObject({ name: "CD19+198-", gate_type: "polygon", x: "116Cd_CD19", y: "198Pt_Live", transforms: { x: "asinh", y: "asinh" } });
    expect(q2.gates[0].vertices).toHaveLength(8);
  });
});

describe("gates and QC populations declared in the file", () => {
  const QC_CSV = [
    "# plane: 195Pt x 194Pt",
    "# plane: 115In x 113In",
    "# plane: 103Rh(display) x 89Y",
    "# gate: CenterGate | rectangle | Time x Center | raw | x full | y 300..600",
    '"# gate: Singlets | rect | Event_length x DNA | linear, asinh | x -3..55 | y 1..8.5"',
    "# gate: Beads | polygon | 140Ce x DNA | asinh | (-0.5,4.3) (2,4.5) (4.2,5.4) (5,8) (-0.4,7.7)",
    "# gate: 194+195- | polygon | 194Pt x 195Pt | asinh | (2,-0.4) (6,-0.4) (6,2) (3.5,1.5) (2.5,1) (2.1,0.5) (2,0)",
    "# population: Cells = CenterGate, Singlets, Beads, AmplitudeGate",
    "# population: Live = Live, Nowhere",
    "name,89Y,113In,115In,194Pt,195Pt",
    "01,1,1,0,0,0",
    "02,0,0,1,1,0",
    "",
  ].join("\n");

  it("parses gate and population lines, Excel quoting included, and reports bad ones", () => {
    const t = parseBarcodeTable(QC_CSV);
    expect(t.problems).toEqual([]);
    expect(t.gateDeclarations.map((g) => g.name)).toEqual(["CenterGate", "Singlets", "Beads", "194+195-"]);
    const center = t.gateDeclarations[0];
    expect(center).toMatchObject({ gate_type: "rectangle", x: "Time", y: "Center", space: "raw", xFull: true, yFull: false });
    expect(center.vertices).toEqual([[0, 300], [1, 300], [1, 600], [0, 600]]);
    const singlets = t.gateDeclarations[1];
    expect(singlets).toMatchObject({ gate_type: "rectangle", space: "display", transforms: { x: "identity", y: "asinh" }, xFull: false });
    expect(singlets.vertices).toEqual([[-3, 1], [55, 1], [55, 8.5], [-3, 8.5]]);
    expect(t.gateDeclarations[2].vertices).toHaveLength(5);
    expect(t.populationDeclarations).toEqual([
      { name: "Cells", parent: null, gates: ["CenterGate", "Singlets", "Beads", "AmplitudeGate"], excluded: [], line: 8 },
      { name: "Live", parent: null, gates: ["Live", "Nowhere"], excluded: [], line: 9 },
    ]);
    const bad = parseBarcodeTable([
      "# gate: Oops | circle | Time x Center | raw | x full | y 1..2",
      "# gate: NoShape | rectangle | Time x Center | raw | y 1..2",
      "# gate: Few | polygon | A x B | asinh | (1,2) (3,4)",
      "# gate: Scale | rectangle | Time x Center | cubic | x full | y 1..2",
      "# population: Empty =",
      "# population: Cells = A",
      "# population: Cells = B",
      "name,89Y,194Pt",
      "01,1,0",
      "",
    ].join("\n"));
    expect(bad.problems).toEqual([
      'Line 1: gate "Oops" must be a rectangle or a polygon (got "circle").',
      'Line 2: rectangle "NoShape" needs "x lo..hi" or "x full" (got "y 1..2").',
      'Line 3: polygon "Few" needs at least three "(x,y)" points (got "(1,2) (3,4)").',
      'Line 4: the scale must be "raw", "asinh", "linear" or one per axis such as "linear, asinh" (got "cubic").',
      'Line 5: population "Empty" lists no gates.',
      'Line 7: population "Cells" is declared twice.',
    ]);
  });

  it("builds the chain from the file, filling undefined gates from the template by name and naming the rest", () => {
    const channels = [...QC_CHANNELS, ...CHANNELS.filter((c) => c.key !== "Time" && c.key !== "103Rh_DNA" && c.key !== "CD45")];
    const s = resolveBarcodeScheme(parseBarcodeTable(QC_CSV), channels);
    expect(s.problems).toEqual([]);
    const eff = effectiveQcChain(s, DEFAULT_BARCODE_TEMPLATE);
    expect(eff.source).toBe("file");
    expect(eff.chain.map((p) => `${p.name}:${p.gates.map((g) => g.name).join("+")}`)).toEqual(["Cells:CenterGate+Singlets+Beads+AmplitudeGate", "Live:Live"]);
    expect(eff.missing).toEqual(["Live / Nowhere"]);
    const r = buildBarcodeGating(s, DEFAULT_BARCODE_TEMPLATE, 5, { qc: true, channels, ranges: { Time: [0, 1000] } });
    expect(r.qc.populations.map((p) => `${p.name}:${p.gates.length}`)).toEqual(["Cells:4", "Live:1"]);
    expect(r.qc.skipped).toEqual(['Live / Nowhere: no "# gate:" line in the file and no gate of that name in the template.']);
    const gate = (name: string) => Object.values(r.gates).find((g) => g.name === name) as PolyRectGate;
    // The file's coordinates, with Time stretched to the sample.
    expect(Math.min(...gate("CenterGate").vertices.map((v) => v[1]))).toBe(300);
    expect(Math.max(...gate("CenterGate").vertices.map((v) => v[0]))).toBeCloseTo(1020);
    expect(gate("Singlets").transforms).toEqual({ Event_length: { kind: "identity" }, "103Rh_DNA": { kind: "asinh", cofactor: 5 } });
    expect(gate("Beads").vertices).toHaveLength(5);
    // AmplitudeGate came from the template by name; the declared barcode polygon replaced the
    // template shape on the 195Pt x 194Pt plane, swapped into the plane's orientation.
    expect(gate("AmplitudeGate")).toBeDefined();
    expect(gate("194+195-").vertices[0]).toEqual([-0.4, 2]);
    expect(gate("194+195-").vertices).toHaveLength(7);
    expect(gate("194-195-").vertices).toEqual(DEFAULT_BARCODE_TEMPLATE.states["--"]);
  });

  it("writes every gate and the chain, and the written file rebuilds the same gates with no template at all", () => {
    const channels = [...QC_CHANNELS, ...CHANNELS.filter((c) => c.key !== "Time" && c.key !== "103Rh_DNA" && c.key !== "CD45")];
    const built = buildBarcodeGating(resolveBarcodeScheme(parseBarcodeTable(TABLE), channels), DEFAULT_BARCODE_TEMPLATE, 5, { qc: true, channels, ranges: { Time: [0, 1000] } });
    const gates = Object.values(built.gates);
    const learned = learnBarcodeTemplate(gates, 5, "test", built.populations, built.root_population_id)!;
    const out = exportBarcodeScheme(gates, built.populations, built.root_population_id, learned, built.populationMetadata, "test");
    const lines = out.csv.split("\n");
    expect(lines.filter((l) => l.startsWith("# gate:"))).toHaveLength(8 + 10);
    expect(lines.filter((l) => l.startsWith("# population:"))).toEqual([
      "# population: Cells = AmplitudeGate, CenterGate, OffsetGate, ResidualGate, WidthGate, SingletsGate, DNA+Bead-Gate",
      "# population: Live = Live",
    ]);
    expect(lines.find((l) => l.startsWith("# gate: CenterGate"))).toBe("# gate: CenterGate | rectangle | Time x Center | raw | x full | y 321.283..615.828");
    expect(lines.find((l) => l.startsWith("# gate: SingletsGate"))).toBe("# gate: SingletsGate | rectangle | Event_length x 103Rh | linear, asinh | x -3.458..55.468 | y 1.043..8.508");
    // An empty template: everything must come from the file.
    const bare = { ...DEFAULT_BARCODE_TEMPLATE, qc: [], states: { "--": [[0, 0], [1, 0], [1, 1]], "+-": [[0, 0], [1, 0], [1, 1]], "-+": [[0, 0], [1, 0], [1, 1]], "++": [[0, 0], [1, 0], [1, 1]] } } as typeof DEFAULT_BARCODE_TEMPLATE;
    const again = resolveBarcodeScheme(parseBarcodeTable(out.csv), channels);
    expect(again.problems).toEqual([]);
    const rebuilt = buildBarcodeGating(again, bare, 5, { qc: true, channels, ranges: { Time: [0, 1000] } });
    expect(rebuilt.qc.skipped).toEqual([]);
    const byName = (r: typeof built) => Object.fromEntries(Object.values(r.gates).map((g) => [g.name, g as PolyRectGate]));
    const a = byName(built);
    const b = byName(rebuilt);
    expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
    for (const name of Object.keys(a)) {
      expect(b[name].gate_type).toBe(a[name].gate_type);
      expect(b[name].x_channel).toBe(a[name].x_channel);
      expect(b[name].y_channel).toBe(a[name].y_channel);
      const av = a[name].vertices.map((v) => v.map((n) => Number(n.toFixed(3))));
      const bv = b[name].vertices.map((v) => v.map((n) => Number(n.toFixed(3))));
      expect(bv).toEqual(av);
    }
    expect(Object.values(rebuilt.populations).map((p) => p.name).sort()).toEqual(Object.values(built.populations).map((p) => p.name).sort());
  });

  it("the template CSV declares the standard chain by name and still parses clean", () => {
    const t = parseBarcodeTable(barcodeSchemeTemplateCsv());
    expect(t.problems).toEqual([]);
    expect(t.populationDeclarations.map((p) => p.name)).toEqual(["Cells", "Live"]);
    expect(t.gateDeclarations.map((g) => g.name)).toEqual(["CenterGate"]);
    const s = resolveBarcodeScheme(t, CHANNELS);
    expect(effectiveQcChain(s, DEFAULT_BARCODE_TEMPLATE).missing).toEqual([]);
  });
});

describe("a hierarchy CSV with no sample table", () => {
  const FLOW_CHANNELS: BarcodeChannelLike[] = [
    { key: "FSC-A", pnn: "FSC-A", marker: null },
    { key: "SSC-A", pnn: "SSC-A", marker: null },
    { key: "CD3", pnn: "FL1-A", marker: "CD3" },
    { key: "CD19", pnn: "FL2-A", marker: "CD19" },
  ];
  const HIER = [
    "# gate: Cells | polygon | FSC-A x SSC-A | raw | (10000,5000) (200000,5000) (200000,150000) (10000,150000)",
    "# gate: CD3+ | rectangle | CD3 x SSC-A | asinh, linear | x 2..8 | y 0..200000",
    "# gate: CD19+ | rectangle | CD19 x SSC-A | asinh, linear | x 2..8 | y 0..200000",
    "# population: Cells = Cells",
    "# population: T cells < Cells = CD3+",
    "# population: B cells < Cells = CD19+, not CD3+",
    "# population: Other < Nowhere = CD19+",
    "",
  ].join("\n");

  it("parses parents and NOT references, and imports as a tree with no problems", () => {
    const t = parseBarcodeTable(HIER);
    expect(t.problems).toEqual([]);
    expect(t.hierarchyOnly).toBe(true);
    expect(t.populationDeclarations.map((p) => [p.name, p.parent, p.gates, p.excluded])).toEqual([
      ["Cells", null, ["Cells"], []],
      ["T cells", "Cells", ["CD3+"], []],
      ["B cells", "Cells", ["CD19+", "CD3+"], ["CD3+"]],
      ["Other", "Nowhere", ["CD19+"], []],
    ]);
    const s = resolveBarcodeScheme(t, FLOW_CHANNELS);
    expect(s.problems).toEqual([]);
    expect(s.planes).toEqual([]);
    expect(s.hierarchyOnly).toBe(true);
    const r = buildBarcodeGating(s, { ...DEFAULT_BARCODE_TEMPLATE, qc: [] }, 5, { qc: true, channels: FLOW_CHANNELS });
    expect(r.nGates).toBe(3);
    expect(r.nPopulations).toBe(0);
    expect(r.qc.populations.map((p) => `${p.name}${p.parent ? `<${p.parent}` : ""}`)).toEqual(["Cells", "T cells<Cells", "B cells<Cells", "Other<Nowhere"]);
    expect(r.qc.skipped).toEqual(['Other: its parent "Nowhere" is not declared above it, so it goes under B cells.']);
    const pops = Object.values(r.populations);
    const byName = Object.fromEntries(pops.map((p) => [p.name, p]));
    expect(byName["T cells"].parent_id).toBe(byName.Cells.population_id);
    expect(byName["B cells"].parent_id).toBe(byName.Cells.population_id);
    expect(byName.Other.parent_id).toBe(byName["B cells"].population_id);
    const gateName = (id: string) => r.gates[id].name;
    expect(byName["B cells"].gate_refs.map((ref) => `${ref.include ? "" : "not "}${gateName(ref.gate_id)}`)).toEqual(["CD19+", "not CD3+"]);
    const cd3 = Object.values(r.gates).find((g) => g.name === "CD3+") as PolyRectGate;
    expect(cd3.gate_type).toBe("rectangle");
    expect(cd3.transforms).toEqual({ CD3: { kind: "asinh", cofactor: 5 }, "SSC-A": { kind: "identity" } });
  });

  it("writes any workspace as gate and population lines that rebuild the same tree", () => {
    const s = resolveBarcodeScheme(parseBarcodeTable(HIER.split("\n").filter((l) => !l.includes("Nowhere")).join("\n")), FLOW_CHANNELS);
    const built = buildBarcodeGating(s, { ...DEFAULT_BARCODE_TEMPLATE, qc: [] }, 5, { qc: true, channels: FLOW_CHANNELS });
    const gates = Object.values(built.gates);
    // An ellipse cannot be written; it is named in the notes and its population keeps the rest.
    const ellipse = { gate_id: "e1", name: "Blob", gate_type: "ellipse", x_channel: "FSC-A", y_channel: "SSC-A", mean: [1, 1], covariance: [[1, 0], [0, 1]], distance_square: 1, color: "#000", label_offset: null } as unknown as (typeof gates)[number];
    const out = exportHierarchyCsv([...gates, ellipse], built.populations, built.root_population_id, "test");
    expect(out.nGates).toBe(3);
    expect(out.nPopulations).toBe(3);
    expect(out.notes).toEqual(['Blob: a ellipse gate cannot be written as a "# gate:" line.']);
    const lines = out.csv.split("\n");
    expect(lines.filter((l) => l.startsWith("# population:"))).toEqual([
      "# population: Cells < All Events = Cells",
      "# population: T cells < Cells = CD3+",
      "# population: B cells < Cells = CD19+, not CD3+",
    ]);
    expect(lines.find((l) => l.startsWith("# gate: CD3+"))).toBe("# gate: CD3+ | rectangle | CD3 x SSC-A | asinh, linear | x 2..8 | y 0..200000");
    const again = resolveBarcodeScheme(parseBarcodeTable(out.csv), FLOW_CHANNELS);
    expect(again.problems).toEqual([]);
    const rebuilt = buildBarcodeGating(again, { ...DEFAULT_BARCODE_TEMPLATE, qc: [] }, 5, { qc: true, channels: FLOW_CHANNELS });
    expect(rebuilt.qc.skipped).toEqual([]);
    const names = (r: typeof built) => Object.values(r.populations).map((p) => `${p.name}<${p.parent_id ? r.populations[p.parent_id].name : ""}`).sort();
    expect(names(rebuilt)).toEqual(names(built));
    const cells = Object.values(rebuilt.gates).find((g) => g.name === "Cells") as PolyRectGate;
    expect(cells.space ?? "raw").toBe("raw");
    expect(cells.vertices).toEqual([[10000, 5000], [200000, 5000], [200000, 150000], [10000, 150000]]);
  });

  it("a file with neither table nor population lines is still a problem", () => {
    const t = parseBarcodeTable("# just a comment\n");
    expect(t.hierarchyOnly).toBe(false);
    expect(t.problems).toEqual(['The file has no header row, and no "# population:" lines either.']);
  });
});
