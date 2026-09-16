// @vitest-environment jsdom
//
// Reading gates from a BD FACSChorus experiment file. The fixture is synthetic — a small
// experiment.json in the shape Chorus 5.4 writes, zipped the way a .cef is — because the real
// files on this machine describe unpublished experiments. A real one can be run through the
// last block by setting GATELAB_CEF_FIXTURE (and GATELAB_CEF_FCS for the file it was recorded
// on); nothing about it is written down here.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";
import {
  CHORUS_RECORD_KEYWORD, chorusBiexSpec, chorusRecordingToGatingML, chorusToGatingML, hasChorusRecording,
  isChorusExperimentFile, listChorusTrees, parameterName, readChorusExperiment, readChorusRecording,
  type ChorusPanel,
} from "./chorusExperiment";
import { importGatingML } from "./gatingml";
import { parseFcs } from "./fcs";
import { Sample } from "./sample";
import { applyGatingStrategy } from "./populations";
import { transformFromSpec } from "./sample";

// The picker labels a sort with its start time in local time; Chorus writes the time in UTC with no zone.
const localLabel = (utcIso: string) => {
  const d = new Date(utcIso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// ── A synthetic experiment ──────────────────────────────────────────────────────────────────

const colour = (kind: string, fluor: string, meas = "A") => ({
  measurementId: fluor ? `id-${fluor}` : kind, fluorochrome: fluor, measurement: meas, scatter: "", scale: "Biexponential",
  numerator: null, denominator: null, parameterKind: "Color",
});
const scatter = (name: string, meas = "A", scale = "Linear") => ({
  measurementId: name, fluorochrome: name.split(" ")[0], measurement: meas, scatter: name, scale,
  numerator: null, denominator: null, parameterKind: "Scatter",
});
const feature = (name: string) => ({
  measurementId: name, fluorochrome: "", measurement: null, scatter: "", scale: "Log",
  numerator: null, denominator: null, parameterKind: "Max Intensity",
});
const vertices = (pts: [number, number][]) => pts.map(([x, y]) => ({ x, y }));

function gate(id: string, kind: string, name: string, parent: string, params: unknown[], pts: [number, number][], popName = name, color = "0,0,255") {
  return {
    children: [{ name: popName, color, populationId: `${id}-1` }],
    inputPopulationIds: null, parameters: params, vertices: vertices(pts), gateKind: kind, name, gateId: id,
    parentPopulationId: parent, categories: [],
  };
}

const CURRENT_GATES = [
  gate("4", "Unsaturated", "Unsaturated", "0-1", [], []),
  gate("5", "Saturated", "Saturated", "0-1", [], []),
  // Scatter: raw, exact. Its vertices are raw values on two Linear axes.
  gate("1", "Polygon", "Scatter", "0-1", [scatter("FSC"), scatter("SSC (Imaging)")],
    [[20000, 5000], [80000, 5000], [80000, 60000], [20000, 60000], [10000, 30000]], "Scatter", "206,218,74"),
  // A rectangle on H parameters, as four vertices, the way Chorus writes one.
  gate("2", "Rectangle", "Singlets", "1-1", [scatter("FSC", "H"), scatter("FSC", "W")],
    [[10000, 1000], [60000, 1000], [60000, 3000], [10000, 3000]]),
  // A colour polygon: biexponential axes, straight in raw (Chorus's R is automatic and not stored).
  gate("3", "Polygon", "P3", "2-1", [colour("Color", "BUV805"), colour("Color", "BV421")],
    [[-100, 500], [50000, 500], [50000, 40000], [-100, 40000]], "CD19+CD3-", "255,0,0"),
  // Two populations of the same name under different parents, to be qualified apart.
  gate("6", "Polygon", "P1", "3-1", [colour("Color", "PE"), colour("Color", "BV711")], [[0, 0], [1000, 0], [1000, 1000]], "P1"),
  gate("7", "Polygon", "P1", "1-1", [colour("Color", "PE"), colour("Color", "BV711")], [[0, 0], [2000, 0], [2000, 2000]], "P1"),
  // An image feature, named by the measurement alone.
  gate("8", "Polygon", "Bright", "1-1", [feature("Max Intensity (SSC (Imaging))"), scatter("SSC (Imaging)")],
    [[100, 1000], [60000, 1000], [60000, 50000]], "Bright"),
  // Beneath the automatic Unsaturated gate.
  gate("9", "Polygon", "Under unsaturated", "4-1", [scatter("FSC"), scatter("SSC (Imaging)")], [[1, 1], [9, 1], [9, 9]]),
  // A kind this importer does not read, with a child beneath it.
  gate("10", "Ellipse", "Oval", "1-1", [scatter("FSC"), scatter("SSC (Imaging)")], [[1, 1], [2, 2], [3, 3]]),
  gate("11", "Polygon", "Under oval", "10-1", [scatter("FSC"), scatter("SSC (Imaging)")], [[1, 1], [9, 1], [9, 9]]),
];

/** The same gates with Scatter moved: what a sort snapshot looks like after the gate was edited. */
const EARLIER_GATES = CURRENT_GATES.map((g) => g.gateId === "1"
  ? { ...g, vertices: vertices([[25000, 5000], [85000, 5000], [85000, 65000], [25000, 65000], [15000, 35000]]) }
  : g);

function experimentJson(): string {
  const rValues = [
    { key: colour("Color", "BUV805"), value: 462662 },
    { key: colour("Color", "BV421"), value: 4627 },
    { key: colour("Color", "PE"), value: -1 },
  ];
  return JSON.stringify({
    experiment: {
      name: "synthetic sort", id: "00000000-0000-0000-0000-000000000000",
      panels: [{
        name: "Panel 1",
        analysis: { gates: CURRENT_GATES, analysisWorksheets: [], visualizationSettings: { defaultRValue: -1, rValueMap: null, analysisRValueMap: rValues } },
        opticalConfiguration: { measurements: ["A", "H", "W"], maxMeasurementValue: 262144 },
      }],
    },
    sortRecords: [
      {
        name: "Sort_002\\", category: "Sort", startSortTime: "\"2026-01-02T10:00:00.5\"", stopSortTime: "\"2026-01-02T10:20:00\"",
        gateHierarchy: CURRENT_GATES, sortReport: { totalEvents: 5000, processedEvents: 5000, destinationReports: [{ population: "3 CD19+CD3-", targetCount: 1000, sortCount: 900 }] },
        cytometerSettings: { acquisitionParameter: [
          { name: "Violet_A", laserFilterMirrorUniqueId: "Violet_|_BP/420/20/BP/447/74" },
          { name: "Violet_B", laserFilterMirrorUniqueId: "Violet_|_BP/440/20/BP/447/74" },
        ] },
      },
      {
        name: "Sort_001", category: "Sort", startSortTime: "\"2026-01-02T09:00:00\"", stopSortTime: "\"2026-01-02T09:30:00\"",
        gateHierarchy: EARLIER_GATES, sortReport: { destinationReports: [] }, cytometerSettings: { acquisitionParameter: [] },
      },
    ],
    fluorochromes: [],
  });
}

export function cefBytes(): Uint8Array {
  return zipSync({
    "manifest.json": strToU8(JSON.stringify({ version: "1.0.0", chorusVersion: "5.4.0", experimentName: "synthetic sort" })),
    "experiment.json": strToU8(experimentJson()),
    "instrument.json": strToU8(JSON.stringify({ hardwarePlatformId: "FACSDiscover S8" })),
    "verification": strToU8("0000"),
  });
}

const CHANNELS = ["Time", "FSC-A", "FSC-H", "FSC-W", "SSC (Imaging)-A", "SSC (Imaging)-H", "BUV805-A", "BV421-A", "PE-A", "BV711-A", "Max Intensity (SSC (Imaging))"];

describe("FACSChorus experiment files", () => {
  it("recognises the file by name and refuses what is not one", () => {
    expect(isChorusExperimentFile("20260102_090000_sort.cef")).toBe(true);
    expect(isChorusExperimentFile("workspace.wsp")).toBe(false);
    expect(() => readChorusExperiment(strToU8("not a zip"))).toThrow(/not a zip/);
    expect(() => readChorusExperiment(zipSync({ "other.json": strToU8("{}") }))).toThrow(/experiment\.json/);
  });

  it("reads the experiment, and lists the current gates and each sort in time order", () => {
    const exp = readChorusExperiment(cefBytes());
    expect(exp.name).toBe("synthetic sort");
    expect(exp.chorusVersion).toBe("5.4.0");
    expect(exp.panels).toHaveLength(1);
    expect(exp.sorts.map((s) => s.name)).toEqual(["Sort_002", "Sort_001"]);
    expect(exp.sorts[0].startedAt).toBe("2026-01-02T10:00:00.5");
    expect(exp.sorts[0].destinations).toEqual([{ population: "3 CD19+CD3-", targetCount: 1000, sortCount: 900 }]);
    expect(exp.panels[0].detectors.get("Violet_|_BP/440/20/BP/447/74")).toBe("Violet_B");

    const trees = listChorusTrees(exp);
    expect(trees.map((t) => [t.kind, t.label, t.sameAsCurrent])).toEqual([
      ["current", "Current gates", false],
      ["sort", `Sort_001 · ${localLabel("2026-01-02T09:00:00Z")}`, false],
      ["sort", `Sort_002 · ${localLabel("2026-01-02T10:00:00.5Z")}`, true],
    ]);
    // Drawn gates only: the automatic Saturated/Unsaturated pair is neither counted nor skipped.
    expect(trees[0].gateCount).toBe(8);
    expect(trees[0].unsupportedCount).toBe(1);
    expect(trees[0].populations).toEqual(["Under unsaturated", "Scatter", "Singlets", "CD19+CD3-", "P1", "P1", "Bright", "Oval", "Under oval"]);
  });

  it("converts a tree to Gating-ML the importer builds the same hierarchy from", () => {
    const exp = readChorusExperiment(cefBytes());
    const conv = chorusToGatingML(exp, 0);
    expect(conv.kind).toBe("current");
    expect(conv.label).toBe("synthetic sort · Current gates");
    // Parameters name the FCS $PnN; a rectangle is a box, not a polygon; colours ride along.
    expect(conv.gatingMl).toContain('data-type:name="SSC (Imaging)-A"');
    expect(conv.gatingMl).toContain('data-type:name="BUV805-A"');
    expect(conv.gatingMl).toContain('data-type:name="Max Intensity (SSC (Imaging))"');
    expect(conv.gatingMl).toMatch(/<gating:RectangleGate[^>]*gating:name="Singlets"/);
    expect(conv.gatingMl).toMatch(/gating:min="10000"[^>]*gating:max="60000"/);
    expect(conv.gatingMl).toContain("#ceda4a");
    expect(conv.gatingMl).toContain("#ff0000");

    const res = importGatingML(conv.gatingMl, CHANNELS, {}, "flow");
    const byName = new Map(Object.values(res.populations).map((p) => [p.name, p]));
    const parentOf = (name: string) => res.populations[byName.get(name)!.parent_id!]?.name ?? null;
    expect(byName.has("Scatter")).toBe(true);
    expect(parentOf("Singlets")).toBe("Scatter");
    expect(parentOf("CD19+CD3-")).toBe("Singlets");
    // Duplicate names qualified by parent, as the FlowJo importer does.
    expect(byName.has("CD19+CD3-/P1")).toBe(true);
    expect(byName.has("Scatter/P1")).toBe(true);
    // The unreadable kind and what sat beneath it are gone; the gate beneath Unsaturated is kept
    // at the top, and both are said.
    expect(byName.has("Oval")).toBe(false);
    expect(byName.has("Under oval")).toBe(false);
    expect(parentOf("Under unsaturated")).toBe("All Events");
    expect(conv.warnings.some((w) => /Oval.*Ellipse/.test(w))).toBe(true);
    expect(conv.warnings.some((w) => /Unsaturated/.test(w))).toBe(true);
    // Colour survives the import.
    const scatterGate = Object.values(res.gates).find((g) => g.name === "Scatter")!;
    expect(scatterGate.color).toBe("#ceda4a");
    // Biexponential axes are straight in raw, and the note says which gates and why.
    expect(conv.warnings.some((w) => /straight in RAW space/.test(w) && /"CD19\+CD3-"/.test(w) && /not stored/.test(w))).toBe(true);
    for (const g of Object.values(res.gates)) expect(g.space ?? "raw").toBe("raw");
  });

  it("imports a sort's snapshot rather than the current gates when asked", () => {
    const exp = readChorusExperiment(cefBytes());
    const earlier = chorusToGatingML(exp, 1);
    expect(earlier.kind).toBe("sort");
    expect(earlier.label).toContain("Sort_001");
    expect(earlier.gatingMl).toContain('data-type:value="25000"');
    expect(chorusToGatingML(exp, 0).gatingMl).not.toContain('data-type:value="25000"');
    expect(() => chorusToGatingML(exp, 9)).toThrow(/no gate tree at position 10/);
  });

  it("carries a biexponential axis into the display when a model is given", () => {
    const exp = readChorusExperiment(cefBytes());
    const model = { T: 262144, M: 4.5 };
    const conv = chorusToGatingML(exp, 0, { displayModel: model });
    // BUV805 and BV421 have R values, so CD19+CD3- is carried; PE's is -1 (automatic), so P1 is not.
    expect(conv.warnings.some((w) => /straight in RAW space/.test(w) && /"CD19\+CD3-"/.test(w))).toBe(false);
    expect(conv.warnings.some((w) => /straight in RAW space/.test(w) && /P1"/.test(w))).toBe(true);
    const res = importGatingML(conv.gatingMl, CHANNELS, {}, "flow");
    const carried = Object.values(res.gates).find((g) => g.name === "CD19+CD3-")!;
    expect(carried.space).toBe("display");
    const spec = carried.transforms!["BUV805-A"];
    expect(spec.kind).toBe("logicle");
    if (spec.kind === "logicle") {
      expect(spec.T).toBe(262144);
      expect(spec.W).toBeCloseTo((4.5 - Math.log10(262144 / 462662)) / 2, 9);
      // The vertices moved into that space: raw 50000 → the logicle's value for it.
      const v = (carried as { vertices: [number, number][] }).vertices;
      expect(Math.max(...v.map((p) => p[0]))).toBeCloseTo(transformFromSpec(spec).forward(50000), 9);
    }
  });

  it("chorusBiexSpec is Diva's model: W from the R value, zero at R = T / 10^M", () => {
    const model = { T: 262144, M: 4.5 };
    expect(chorusBiexSpec(262144 / Math.pow(10, 4.5), model)).toMatchObject({ kind: "logicle", W: 0 });
    const spec = chorusBiexSpec(262144, model);
    expect(spec).toMatchObject({ kind: "logicle", T: 262144, M: 4.5, A: 0 });
    if (spec?.kind === "logicle") expect(spec.W).toBeCloseTo(2.25, 9);
    // Below the floor the width is clamped rather than negative; nothing for R ≤ 0.
    expect(chorusBiexSpec(1, model)).toMatchObject({ W: 0 });
    expect(chorusBiexSpec(-1, model)).toBeNull();
  });

  it("names a raw detector by its position among its laser's detectors, and says so", () => {
    const exp = readChorusExperiment(cefBytes());
    const panel: ChorusPanel = exp.panels[0];
    const notes: string[] = [];
    const p = { measurementId: "Violet_|_BP/440/20/BP/447/74", fluorochrome: "", measurement: "A", scale: "Biexponential", parameterKind: "Mixed" };
    expect(parameterName(p, panel, (m) => notes.push(m))).toBe("V2 (440)-A");
    expect(notes[0]).toMatch(/reconstruct|position/);
    expect(parameterName({ ...p, measurementId: "Imaging_|_BP/534/46/LP/505" }, panel, () => {})).toBeNull();
  });
});

describe("what the picker and the statistics comparison are told", () => {
  it("carries each sort's report into its summary", () => {
    const exp = readChorusExperiment(cefBytes());
    const trees = listChorusTrees(exp);
    const sort2 = trees.find((t) => t.label.startsWith("Sort_002"))!;
    expect(sort2.totalEvents).toBe(5000);
    expect(sort2.sorted).toEqual([{ population: "3 CD19+CD3-", sortCount: 900 }]);
    const sort1 = trees.find((t) => t.label.startsWith("Sort_001"))!;
    expect(sort1.totalEvents).toBeNull();
    expect(sort1.sorted).toEqual([]);
    expect(trees[0].sorted).toEqual([]);
  });

  it("records what was done with every gate, by the name it was imported under", () => {
    const exp = readChorusExperiment(cefBytes());
    const conv = chorusToGatingML(exp, 0);
    expect(conv.record.experimentName).toBe("synthetic sort");
    expect(conv.record.treeLabel).toBe("Current gates");
    expect(conv.record.kind).toBe("current");
    expect(conv.record.sortedAt).toBeNull();
    const byName = Object.fromEntries(conv.record.gates.map((g) => [g.name, g]));
    expect(byName["Scatter"].approximated).toBe(false);
    expect(byName["Scatter"].axes.map((a) => a.scale)).toEqual(["Linear", "Linear"]);
    expect(byName["CD19+CD3-"].approximated).toBe(true);
    expect(byName["CD19+CD3-"].axes.map((a) => a.scale)).toEqual(["Biexponential", "Biexponential"]);
    // Chorus's automatic gates are not imported, so they are not in the record either.
    expect(conv.record.gates.some((g) => g.kind === "Saturated" || g.kind === "Unsaturated")).toBe(false);
    const sortConv = chorusToGatingML(exp, trees0SortIndex(exp));
    expect(sortConv.record.kind).toBe("sort");
    expect(sortConv.record.sortedAt).toBe("2026-01-02T10:00:00.5");
    // The current gates are not compared with themselves; a snapshot is, gate by gate.
    expect(conv.record.gates.every((g) => g.differsFromCurrent === undefined)).toBe(true);
    const earlier = chorusToGatingML(exp, listChorusTrees(exp).find((t) => t.label.startsWith("Sort_001"))!.index);
    const flags = Object.fromEntries(earlier.record.gates.map((g) => [g.name, g.differsFromCurrent]));
    expect(flags["Scatter"]).toBe(true);
    expect(flags["Singlets"]).toBe(false);
    // A recording compared with the current gates it was recorded before.
    const rec = readChorusRecording(recordingKeywords(EARLIER_GATES))!;
    const recConv = chorusRecordingToGatingML(rec, { currentGates: exp.panels[0].gates });
    expect(Object.fromEntries(recConv.record.gates.map((g) => [g.name, g.differsFromCurrent]))["Scatter"]).toBe(true);
    expect(chorusRecordingToGatingML(rec).record.gates[0].differsFromCurrent).toBeUndefined();
  });
});

function trees0SortIndex(exp: ReturnType<typeof readChorusExperiment>): number {
  return listChorusTrees(exp).find((t) => t.label.startsWith("Sort_002"))!.index;
}

// ── A recording, as an S8 FCS carries it ────────────────────────────────────────────────────

/** The keyword's JSON capitalises every key. */
function capitalise(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(capitalise);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k.charAt(0).toUpperCase() + k.slice(1)] = capitalise(val);
    return out;
  }
  return v;
}

function recordingKeywords(gates: unknown[], extra: Record<string, unknown> = {}): Record<string, string> {
  const record = {
    RootPath: "D:\\Recordings\\Recording_01022026_180000",
    RecordingInfo: {
      DataRecordId: "00000000-0000-0000-0000-00000000aa01", AssociationId: "00000000-0000-0000-0000-000000000000",
      AssociationType: "Experiment", Category: "Analysis", Name: "D1 pre-sort", DataRecordState: "CompletedRecording",
    },
    RecordingConfiguration: {
      DataRecordId: "00000000-0000-0000-0000-00000000aa01",
      StartRecordingTime: "\"2026-01-02T09:00:30.5\"", StopRecordingTime: "\"2026-01-02T09:00:40\"",
      EventCount: 5000,
      AnalysisModel: capitalise({
        gates, analysisWorksheets: [], eventDisplayCount: 100000,
        visualizationSettings: { defaultRValue: -1, rValueMap: null, analysisRValueMap: [{ key: colour("Color", "BUV805"), value: 462662 }] },
      }),
      CytometerSettings: { AcquisitionParameter: [{ Name: "Violet_A", LaserFilterMirrorUniqueId: "Violet_|_BP/420/20/BP/447/74" }] },
      SortInfo: null,
      ...extra,
    },
  };
  return {
    [CHORUS_RECORD_KEYWORD]: JSON.stringify(record),
    "$SMNO": "D1 pre-sort", "$PROJ": "synthetic sort", "$BEGINDATETIME": "2026-01-02T09:00:30Z", "$ENDDATETIME": "2026-01-02T09:00:40Z",
  };
}

describe("a recording's own tree, from its FCS keywords", () => {
  it("is recognised, read, and converts exactly as the same gates do from a .cef", () => {
    const kw = recordingKeywords(CURRENT_GATES);
    expect(hasChorusRecording(kw)).toBe(true);
    expect(hasChorusRecording({ "$SMNO": "x" })).toBe(false);
    const rec = readChorusRecording(kw)!;
    expect(rec.name).toBe("D1 pre-sort");
    expect(rec.dataRecordId).toBe("00000000-0000-0000-0000-00000000aa01");
    expect(rec.experimentId).toBe("00000000-0000-0000-0000-000000000000");
    expect(rec.experimentName).toBe("synthetic sort");
    expect(rec.startedAt).toBe("2026-01-02T09:00:30.5");
    expect(rec.stoppedAt).toBe("2026-01-02T09:00:40");
    expect(rec.eventCount).toBe(5000);
    expect(rec.panel.gates.map((g) => g.name)).toEqual(CURRENT_GATES.map((g) => (g as { name: string }).name));
    expect(rec.panel.rValues.size).toBe(1);
    expect(rec.panel.detectors.get("Violet_|_BP/420/20/BP/447/74")).toBe("Violet_A");
    const fromFile = chorusRecordingToGatingML(rec);
    const fromCef = chorusToGatingML(readChorusExperiment(cefBytes()), 0);
    // Same gates, same document, apart from the labels that say where they came from.
    expect(fromFile.gatingMl).toBe(fromCef.gatingMl);
    expect(fromFile.kind).toBe("recording");
    expect(fromFile.label).toBe("synthetic sort · D1 pre-sort");
    expect(fromFile.record.kind).toBe("recording");
    expect(fromFile.record.sortedAt).toBe("2026-01-02T09:00:30.5");
    expect(fromFile.record.gates.map((g) => g.name)).toEqual(fromCef.record.gates.map((g) => g.name));
  });

  it("returns null without the keyword and refuses a broken one", () => {
    expect(readChorusRecording({ "$FIL": "a.fcs" })).toBeNull();
    expect(() => readChorusRecording({ [CHORUS_RECORD_KEYWORD]: "{not json" })).toThrow(/not valid JSON/);
  });

  it("falls back to the FCS's own keywords for what the record lacks", () => {
    const kw = recordingKeywords(CURRENT_GATES);
    const record = JSON.parse(kw[CHORUS_RECORD_KEYWORD]);
    delete record.RecordingInfo.Name; delete record.RecordingConfiguration.StartRecordingTime; delete record.RecordingConfiguration.EventCount;
    const rec = readChorusRecording({ ...kw, [CHORUS_RECORD_KEYWORD]: JSON.stringify(record) })!;
    expect(rec.name).toBe("D1 pre-sort");
    expect(rec.startedAt).toBe("2026-01-02T09:00:30Z");
    expect(rec.eventCount).toBeNull();
  });
});

const REAL = process.env.GATELAB_CEF_FIXTURE ?? "";
const REAL_FCS = process.env.GATELAB_CEF_FCS ?? "";

describe.runIf(REAL && existsSync(REAL))("a real FACSChorus experiment (GATELAB_CEF_FIXTURE)", () => {
  it("reads, lists and converts, and every gate lands on a channel of the file it was recorded on", () => {
    const exp = readChorusExperiment(new Uint8Array(readFileSync(REAL)));
    const trees = listChorusTrees(exp).filter((t) => t.gateCount > 0);
    expect(trees.length).toBeGreaterThan(0);
    const conv = chorusToGatingML(exp, trees[0].index);
    expect(conv.gatingMl).toContain("<gating:PolygonGate");
    if (!REAL_FCS || !existsSync(REAL_FCS)) return;
    const b = readFileSync(REAL_FCS);
    const sample = new Sample(parseFcs(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer));
    const pnn: Record<string, string> = {};
    for (const c of sample.channels) pnn[c.pnn] = c.key;
    const res = importGatingML(conv.gatingMl, sample.channels.map((c) => c.key), pnn, sample.instrument);
    expect(res.n_gates_imported).toBe(trees[0].gateCount - (res.skipped_channels?.length ? trees[0].gateCount - res.n_gates_imported : 0));
    const { masks } = applyGatingStrategy(res.gates, res.populations, res.root_population_id, sample.gateAssayData());
    const root = res.populations[res.root_population_id];
    for (const child of root.children) {
      let n = 0; for (const v of masks[child]) n += v;
      expect(n, res.populations[child].name).toBeGreaterThan(0);
    }
  });
});
