// @vitest-environment jsdom
// A channel name another program wrote, against the loaded file's channels: GateLabR's rules
// (PR #63), at every door a name comes in by. Every name here is synthetic.
import { describe, it, expect } from "vitest";
import { metalOf, metalSpellings, punctuationInsensitive } from "./channelMatch";
import { importGatingML, resolveChannel } from "./gatingml";
import { massToken, tokenMatchesChannel } from "./barcodeMass";
import {
  buildBarcodeGating,
  parseBarcodeTable,
  resolveBarcodeScheme,
  resolveMassToken,
  resolveQcChannel,
  type BarcodeChannelLike,
} from "./barcodeScheme";
import { DEFAULT_BARCODE_TEMPLATE } from "./barcodeTemplate";

/** A Gating-ML file with one range gate on `x` and `y`. */
function rectOn(x: string, y = "SSC-A"): string {
  const dim = (name: string) => `<gating:dimension gating:min="1" gating:max="2">
      <data-type:fcs-dimension data-type:name="${name}"/></gating:dimension>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
    <gating:Gating-ML xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"
      xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">
      <gating:RectangleGate gating:id="g1" gating:name="Gate">${dim(x)}${dim(y)}</gating:RectangleGate>
    </gating:Gating-ML>`;
}

/** The channel the gate on `name` lands on, or the refusal the import throws. */
function landsOn(name: string, session: string[], pnn: Record<string, string>, instrument: "flow" | "cytof"): string {
  try {
    const res = importGatingML(rectOn(name, session.includes("SSC-A") ? "SSC-A" : session[0]), session, pnn, instrument);
    return Object.values(res.gates)[0].x_channel;
  } catch (e) {
    return `refused: ${(e as Error).message.includes(JSON.stringify(name)) ? name : (e as Error).message}`;
  }
}

describe("channelMatch", () => {
  it("keeps the letters of every script, and signs, when case and punctuation are ignored", () => {
    expect(punctuationInsensitive("TCRγδ")).toBe("tcrγδ");
    expect(punctuationInsensitive("TCRγδ")).not.toBe(punctuationInsensitive("TCRαβ"));
    expect(punctuationInsensitive("IFN-γ")).toBe("ifnγ");
    expect(punctuationInsensitive("CD3+")).toBe("cd3+");
    expect(punctuationInsensitive("CD3-")).toBe("cd3-");
    expect(punctuationInsensitive("CD3")).toBe("cd3");
    // A dash between two letters or digits is a separator; with a space on either side it is a sign.
    expect(punctuationInsensitive("FITC-A")).toBe("fitca");
    expect(punctuationInsensitive("FITC_A")).toBe("fitca");
    expect(punctuationInsensitive("v-FLT525_30-E-A")).toBe(punctuationInsensitive("v-FLT525/30-E-A"));
    expect(punctuationInsensitive("CD4 -")).toBe("cd4-");
    expect(punctuationInsensitive("CD4 - A")).toBe("cd4-a");
    // The minus sign U+2212 is a minus.
    expect(punctuationInsensitive("CD8−")).toBe("cd8-");
    expect(punctuationInsensitive("IFN−γ")).toBe("ifnγ");
  });

  it("finds a metal only as an element in its own case with one of its natural masses", () => {
    expect(metalOf("Nd145Di")).toBe("nd145");
    expect(metalOf("145Nd")).toBe("nd145");
    expect(metalOf("CD4 (Nd145Di)")).toBe("nd145");
    expect(metalOf("BC2(Pr141)Dd")).toBe("pr141");
    expect(metalOf("140Ce_Beads")).toBe("ce140");
    expect(metalOf("CD3 (Y89Di)")).toBe("y89");
    for (const marker of ["CD45", "CD45RA", "CD11c", "CD11b", "CD62L", "CD111", "B220", "Ki67", "Ly108", "BV421-A", "v-FLT525/30-E-A", "145nd"]) {
      expect(metalOf(marker), marker).toBe("");
    }
    expect(metalSpellings("89Y_CD45 Pt194Di").map((s) => s.metal)).toEqual(["y89", "pt194"]);
  });
});

describe("a gate's channel in a Gating-ML file", () => {
  it("is not read on another channel whose name differs only in letters outside ASCII", () => {
    const session = ["TCRαβ", "IFN-γ", "IL-1β", "CD8α", "SSC-A"];
    const pnn = { "B1-A": "TCRαβ", "B2-A": "IFN-γ", "B3-A": "IL-1β", "B4-A": "CD8α", "SSC-A": "SSC-A" };
    for (const instrument of ["flow", "cytof"] as const) {
      expect(landsOn("TCRγδ", session, pnn, instrument)).toBe("refused: TCRγδ");
      expect(landsOn("IFN-α", session, pnn, instrument)).toBe("refused: IFN-α");
      expect(landsOn("IL-1α", session, pnn, instrument)).toBe("refused: IL-1α");
      expect(landsOn("CD8β", session, pnn, instrument)).toBe("refused: CD8β");
      // The same name, spelled another way, still finds its channel.
      expect(landsOn("tcrαβ", session, pnn, instrument)).toBe("TCRαβ");
      expect(landsOn("IFNγ", session, pnn, instrument)).toBe("IFN-γ");
    }
    // Through a $PnN the file names, too.
    const byPnn = { "TCRαβ-A": "TCRαβ", "SSC-A": "SSC-A" };
    expect(landsOn("TCRγδ-A", ["TCRαβ", "SSC-A"], byPnn, "flow")).toBe("refused: TCRγδ-A");
    expect(landsOn("TCRαβ_A", ["TCRαβ", "SSC-A"], byPnn, "flow")).toBe("TCRαβ");
  });

  it("is not read on another channel whose name differs only in a sign", () => {
    const pnn = { "B1-A": "CD3+", "SSC-A": "SSC-A" };
    expect(landsOn("CD3-", ["CD3+", "SSC-A"], pnn, "flow")).toBe("refused: CD3-");
    expect(landsOn("CD3", ["CD3+", "SSC-A"], pnn, "flow")).toBe("refused: CD3");
    expect(landsOn("cd3+", ["CD3+", "SSC-A"], pnn, "flow")).toBe("CD3+");
    // U+2212 is a minus: refused over CD8, and it finds CD8-.
    expect(landsOn("CD8−", ["CD8", "SSC-A"], { "B1-A": "CD8", "SSC-A": "SSC-A" }, "flow")).toBe("refused: CD8−");
    expect(landsOn("CD8−", ["CD8-", "SSC-A"], { "B1-A": "CD8-", "SSC-A": "SSC-A" }, "flow")).toBe("CD8-");
  });

  it("still finds a detector FlowJo spells with another separator", () => {
    const session = ["FITC-A", "SSC-A"];
    const pnn = { "FITC-A": "FITC-A", "SSC-A": "SSC-A" };
    expect(landsOn("FITC_A", session, pnn, "flow")).toBe("FITC-A");
    expect(landsOn("fitc-a", session, pnn, "flow")).toBe("FITC-A");
  });

  it("refuses a name that two channels answer to, rather than take the first", () => {
    expect(landsOn("CD3.A", ["CD3-A", "CD3_A", "SSC-A"], {}, "flow")).toBe("refused: CD3.A");
    expect(landsOn("cd3", ["Cd3", "CD3", "SSC-A"], {}, "flow")).toBe("refused: cd3");
    expect(resolveChannel("cd3", ["Cd3", "CD3"], {}, "flow")).toBeNull();
    expect(resolveChannel("cd3", ["Cd3", "CD4"], {}, "flow")).toBe("Cd3");
  });

  it("takes a mass cytometry name for another channel only through a metal both spell", () => {
    // GateLab keys mass cytometry channels by marker, so a marker name the data lack reaches the metal step.
    const session = ["CD11b", "CD62P", "CD8", "CD3"];
    const pnn = { "Nd145Di": "CD11b", "Sm149Di": "CD62P", "Cd111Di": "CD8", "Y89Di": "CD3" };
    expect(landsOn("CD11c", session, pnn, "cytof")).toBe("refused: CD11c");
    expect(landsOn("CD62L", session, pnn, "cytof")).toBe("refused: CD62L");
    // CD111 is a marker, not cadmium 111.
    expect(landsOn("CD111", session, pnn, "cytof")).toBe("refused: CD111");
    // A metal still finds its channel, spelled any way round.
    expect(landsOn("145Nd", session, pnn, "cytof")).toBe("CD11b");
    expect(landsOn("CD11b (Nd145Di)", session, pnn, "cytof")).toBe("CD11b");
    expect(landsOn("Cd111", session, pnn, "cytof")).toBe("CD8");
    // Only on mass cytometry data.
    expect(landsOn("145Nd", session, pnn, "flow")).toBe("refused: 145Nd");
  });
});

describe("a barcode scheme's or hierarchy CSV's channel", () => {
  const CYTOF: BarcodeChannelLike[] = [
    { key: "Ly108", pnn: "Sm149Di", marker: "Ly108" },
    { key: "Pd108Di", pnn: "Pd108Di", marker: null },
    { key: "CD11b", pnn: "Nd145Di", marker: "CD11b" },
  ];

  it("names a channel by its mass only through a metal the channel's name spells", () => {
    expect(massToken("Ly108")).toBeNull();
    expect(massToken("Ki67")).toBeNull();
    expect(massToken("108")).toEqual({ mass: 108, element: null });
    expect(tokenMatchesChannel({ mass: 108, element: null }, "Ly108")).toBe(false);
    expect(tokenMatchesChannel({ mass: 108, element: null }, "Pd108Di")).toBe(true);
    // "108" was ambiguous between the Pd108 channel and a marker whose name holds 108.
    expect(resolveMassToken("108", CYTOF)).toEqual({ key: "Pd108Di" });
    expect(resolveMassToken("108Pd", CYTOF)).toEqual({ key: "Pd108Di" });
    expect(resolveMassToken("CD11c", CYTOF)).toEqual({ candidates: [] });
  });

  it("does not place a QC gate on another channel whose name differs in letters outside ASCII, in a sign, or by a suffix", () => {
    const flow: BarcodeChannelLike[] = [
      { key: "TCRαβ", pnn: "B1-A", marker: "TCRαβ" },
      { key: "CD3+", pnn: "B2-A", marker: "CD3+" },
      { key: "CD38", pnn: "B3-A", marker: "CD38" },
      { key: "Event length", pnn: "Event_length", marker: null },
      { key: "SSC-A", pnn: "SSC-A", marker: null },
    ];
    expect(resolveQcChannel("TCRγδ", flow)).toBeNull();
    expect(resolveQcChannel("tcr αβ", flow)).toBe("TCRαβ");
    expect(resolveQcChannel("CD3-", flow)).toBeNull();
    // A name that is not a role word is not taken for a longer one.
    expect(resolveQcChannel("CD3", flow)).toBeNull();
    expect(resolveQcChannel("Event_length", flow)).toBe("Event length");
    expect(resolveQcChannel("CD11c", CYTOF)).toBeNull();
  });

  it("leaves a hierarchy CSV's gate out, by name, where its channel is not in the file", () => {
    const channels: BarcodeChannelLike[] = [
      { key: "FSC-A", pnn: "FSC-A", marker: null },
      { key: "SSC-A", pnn: "SSC-A", marker: null },
      { key: "TCRαβ", pnn: "FL1-A", marker: "TCRαβ" },
    ];
    const table = parseBarcodeTable([
      "# gate: Cells | polygon | FSC-A x SSC-A | raw | (10000,5000) (200000,5000) (200000,150000) (10000,150000)",
      "# gate: gd | rectangle | TCRγδ x SSC-A | asinh, linear | x 2..8 | y 0..200000",
      "# population: Cells = Cells",
      "# population: gd T < Cells = gd",
      "",
    ].join("\n"));
    const r = buildBarcodeGating(resolveBarcodeScheme(table, channels), { ...DEFAULT_BARCODE_TEMPLATE, qc: [] }, 5, { qc: true, channels });
    expect(r.qc.skipped).toContain("gd T / gd: no channel matches TCRγδ.");
    expect(Object.values(r.gates).map((g) => g.x_channel)).toEqual(["FSC-A"]);
  });
});

describe("a hierarchy CSV, barcode scheme or template an earlier GateLab saved", () => {
  // 60a69a9 and the public 0.8.3 release took any one or two letters and two or three digits of a
  // name for an isotope: they wrote Ki67 as "67Ki", B220 as "220B", APC-A750-A as "750A", V10-A as
  // "10V" and V450-A as "450V", named a barcode gate on V450-A x B530-A "450-530+", and keyed a saved
  // template's plane by "530Bx450V". None of those labels spells a metal.
  const FLOW: BarcodeChannelLike[] = [
    { key: "FSC-A", pnn: "FSC-A", marker: null },
    { key: "SSC-A", pnn: "SSC-A", marker: null },
    { key: "CD3", pnn: "FL1-A", marker: "CD3" },
    { key: "Ki67", pnn: "FL2-A", marker: "Ki67" },
    { key: "B220", pnn: "FL3-A", marker: "B220" },
    { key: "APC-A750-A", pnn: "APC-A750-A", marker: null },
    { key: "V10-A", pnn: "V10-A", marker: null },
    { key: "V450-A", pnn: "V450-A", marker: null },
    { key: "B530-A", pnn: "B530-A", marker: null },
  ];

  it("reads a hierarchy CSV's gate on a channel it wrote by a label that spells no metal", () => {
    // As the 60a69a9 writer wrote it (exportHierarchyCsv).
    const table = parseBarcodeTable([
      "# GateLab hierarchy, saved 2026-09-25 from a workspace.",
      "# Gates first, then populations naming their parent; import this file to rebuild the hierarchy.",
      "# gate: Cells | rectangle | FSC-A x SSC-A | raw | x 10000..200000 | y 5000..150000",
      "# gate: Ki67+ | rectangle | 67Ki x SSC-A | asinh(5), linear | x 2..8 | y 0..200000",
      "# gate: B220+ | rectangle | 220B x CD3 | asinh(5) | x 2..8 | y 0..3",
      "# gate: A750+ | rectangle | 750A x 10V | asinh(5) | x 2..8 | y 0..3",
      "# population: Cells < All Events = Cells",
      "# population: Prolif < Cells = Ki67+",
      "# population: B < Cells = B220+",
      "# population: X < Cells = A750+",
      "",
    ].join("\n"));
    const r = buildBarcodeGating(resolveBarcodeScheme(table, FLOW), { ...DEFAULT_BARCODE_TEMPLATE, qc: [] }, 5, { qc: true, channels: FLOW });
    expect(r.qc.skipped).toEqual([]);
    expect(Object.values(r.gates).map((g) => [g.name, g.x_channel, g.y_channel])).toEqual([
      ["Cells", "FSC-A", "SSC-A"],
      ["Ki67+", "Ki67", "SSC-A"],
      ["B220+", "B220", "CD3"],
      ["A750+", "APC-A750-A", "V10-A"],
    ]);
  });

  it("takes such a label only for the one channel that gives it, and only once the name and its metal have found none", () => {
    expect(resolveQcChannel("10V", FLOW)).toBe("V10-A");
    expect(resolveMassToken("450V", FLOW)).toEqual({ key: "V450-A" });
    // Two channels give "10V": refused, and both are named.
    const both = [...FLOW, { key: "V10-H", pnn: "V10-H", marker: null }];
    expect(resolveQcChannel("10V", both)).toBeNull();
    expect(resolveMassToken("10V", both)).toEqual({ candidates: ["V10-A", "V10-H"] });
    // A metal, a bare mass and a marker name are read as before: never through such a label.
    const cytof: BarcodeChannelLike[] = [
      { key: "Ly108", pnn: "Sm149Di", marker: "Ly108" },
      { key: "Pd108Di", pnn: "Pd108Di", marker: null },
      // Each spells no metal, the letters being run into a word, and 60a69a9 labelled them "149Sm" and "150Sm".
      { key: "Sm149x", pnn: "Sm149x", marker: null },
      { key: "Sm150x", pnn: "Sm150x", marker: null },
    ];
    expect(resolveMassToken("108", cytof)).toEqual({ key: "Pd108Di" });
    expect(resolveMassToken("108Ly", cytof)).toEqual({ key: "Ly108" });
    expect(resolveMassToken("149Sm", cytof)).toEqual({ key: "Ly108" });
    expect(resolveMassToken("150Sm", cytof)).toEqual({ candidates: [] });
    expect(resolveMassToken("CD11c", cytof)).toEqual({ candidates: [] });
  });

  it("reads a barcode scheme whose columns, planes and gates it wrote by such labels, and keeps its gates' shapes", () => {
    // As the 60a69a9 writer wrote it (exportBarcodeScheme), from gates it had named itself.
    const table = parseBarcodeTable([
      "# GateLab barcode scheme, saved 2026-09-25 from a workspace.",
      "# Gates are listed so this file reproduces the whole hierarchy; QC populations nest in the order given.",
      "# plane: 530B x 450V",
      "# gate: 450-530- | polygon | 530B x 450V | asinh(5) | (0,0) (2,0) (2,2) (0,2)",
      "# gate: 450-530+ | polygon | 530B x 450V | asinh(5) | (4,0.2) (6,0.2) (6,2.2) (4,2.2)",
      "# gate: 450+530- | polygon | 530B x 450V | asinh(5) | (0.1,4) (2.1,4) (2.1,6) (0.1,6)",
      "# gate: 450+530+ | polygon | 530B x 450V | asinh(5) | (4.3,4.1) (6.3,4.1) (6.3,6.1) (4.3,6.1)",
      "name,file_name,450V,530B",
      "S1,S1.fcs,0,0",
      "S2,S2.fcs,0,1",
      "S3,S3.fcs,1,0",
      "S4,S4.fcs,1,1",
      "",
    ].join("\n"));
    const scheme = resolveBarcodeScheme(table, FLOW);
    expect(scheme.problems).toEqual([]);
    expect(scheme.channels).toEqual(["V450-A", "B530-A"]);
    expect(scheme.metadataColumns).toEqual([]);
    expect(scheme.planes).toEqual([{ x: "B530-A", y: "V450-A", xIsBarcode: true, yIsBarcode: true }]);
    const r = buildBarcodeGating(scheme, DEFAULT_BARCODE_TEMPLATE, 5, { channels: FLOW });
    expect(r.unusedDeclarations).toEqual([]);
    expect(Object.values(r.gates).map((g) => [g.name, g.x_channel, g.y_channel, g.gate_type === "polygon" ? g.vertices[0] : null])).toEqual([
      ["450-530-", "B530-A", "V450-A", [0, 0]],
      ["450-530+", "B530-A", "V450-A", [4, 0.2]],
      ["450+530-", "B530-A", "V450-A", [0.1, 4]],
      ["450+530+", "B530-A", "V450-A", [4.3, 4.1]],
    ]);
  });

  it("finds a saved template's plane by the label it keyed the plane by", () => {
    const own = (dx: number) => Object.fromEntries((["--", "+-", "-+", "++"] as const).map((k) =>
      [k, DEFAULT_BARCODE_TEMPLATE.states[k].map(([x, y]) => [x + dx, y])])) as typeof DEFAULT_BARCODE_TEMPLATE.states;
    const template = { ...DEFAULT_BARCODE_TEMPLATE, planes: { "530Bx450V": { states: own(0.25) } } };
    const table = parseBarcodeTable(["name,V450-A,B530-A", "S1,0,0", "S2,0,1", "S3,1,0", "S4,1,1", ""].join("\n"));
    const scheme = resolveBarcodeScheme(table, FLOW, [{ x: "B530-A", y: "V450-A", xIsBarcode: true, yIsBarcode: true }]);
    expect(scheme.problems).toEqual([]);
    const r = buildBarcodeGating(scheme, template, 5, { channels: FLOW });
    // The "--" gate is built first.
    const minus = Object.values(r.gates)[0];
    expect(minus.gate_type === "polygon" ? minus.vertices : null).toEqual(own(0.25)["--"]);
  });
});
